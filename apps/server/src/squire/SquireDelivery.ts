/**
 * Turns a Squire's `pending` event rows into turns on its home thread. One
 * batch at a time per Squire: its rows are marked `batched`
 * before the dispatch and stay so until the run that consumed them ends, so
 * a restart re-dispatches the same command id and receipt replay keeps the
 * home thread at one message.
 */
import {
  CommandId,
  DEFAULT_SQUIRE_BUDGETS,
  MessageId,
  ProjectId,
  type RunId,
  SquireBudgets,
  type SquireBatchEvent,
  type SquireBatchFailingCheck,
  SquireCardId,
  SquireCardPayload,
  SquireCardTrigger,
  SquireEvent,
  type SquireGrantKind,
  type SquireId,
  type SquireTurnOrigin,
  type SquireTurnSummary,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type UnknownUnionMember,
  isUnknownUnionMember,
  renderSquireEventBatchShown,
  squireMergeableFromSnapshot,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { LecturnHookRejectedError } from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { isStaveSpaceBusy } from "../stave/StaveOrchestrationHooks.ts";
import * as StaveSpaceLock from "../stave/StaveSpaceLock.ts";
import * as SquireContainers from "./SquireContainers.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import { SquireRepository, type SquireEventRow, type SquireRow } from "./SquireRepository.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import {
  ROOM_CONTEXT_LOG_KEY,
  type RoomContextBlock,
  advanceRoomCursors,
  collectRoomContext,
  encodeRoomContextWindows,
  hasSquireAuthoredPost,
  readRoomContextWindows,
  rewindRoomCursors,
  roomContextFromWindows,
} from "./squireRoomContext.ts";
import { userStartedLeadKeys } from "./squireMessageGuards.ts";
import { SquireSummaries } from "./SquireSummaries.ts";
import {
  type SquireEventPayload,
  SquireEventPayloadJson,
  type SquireEventPullRequest,
  isSummaryBearing,
} from "./squireEvents.ts";

export type SquireDeliveryError =
  | PersistenceSqlError
  | ProjectionStore.ProjectionStoreV2Error
  | ProjectStore.ProjectStoreV2Error
  | Orchestrator.OrchestratorV2Error;

export class SquireDelivery extends Context.Service<
  SquireDelivery,
  {
    /** Non-blocking; serialized and coalesced per Squire; failures are logged. */
    readonly wake: (squireId: SquireId) => Effect.Effect<void>;
    /** Dispatches the next batch when the Squire is active, ready, and its home thread idle. */
    readonly deliverReady: (squireId: SquireId) => Effect.Effect<void, SquireDeliveryError>;
    /**
     * A home-thread run ended: its batch (if it carried one) becomes
     * `delivered`, an FYI card is written for each thread the turn raised no
     * item on, and the next batch is woken. Idempotent.
     */
    readonly finalizeRun: (input: {
      readonly squireId: SquireId;
      readonly homeThreadId: ThreadId;
      readonly runId: RunId;
      readonly status: string;
    }) => Effect.Effect<void, SquireDeliveryError>;
    /** Startup: every batch still `batched` is dispatched again under its command id. */
    readonly redispatchBatched: Effect.Effect<void, SquireDeliveryError>;
    /** Waits for every wake in flight. */
    readonly drain: Effect.Effect<void>;
  }
>()("lecturn/squire/SquireDelivery") {}

const MESSAGE_PREFIX = "message:squire:";
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Refusals a later attempt of the same command cannot get past. */
const TERMINAL_DISPATCH_ERRORS: ReadonlySet<string> = new Set([
  "OrchestratorCommandPreviouslyRejectedError",
  "OrchestratorCommandRejectedError",
  "OrchestratorCommandIdConflictError",
  "OrchestratorSubagentThreadReadOnlyError",
  "OrchestratorThreadAboveModeLimitError",
]);

const isHookRejection = Schema.is(LecturnHookRejectedError);
/** Stave refused the turn only because a Stave operation outlasted the admission wait. */
const isSpaceBusy = (error: Orchestrator.OrchestratorV2Error) =>
  error._tag === "OrchestratorCommandRejectedError" &&
  isHookRejection(error.cause) &&
  isStaveSpaceBusy(error.cause);

/** The Lead hears only these kinds. */
const LEAD_KINDS: ReadonlySet<string> = new Set([
  "digest-due",
  "sweep-due",
  "message",
  "room-proposed",
  "item-raised",
  "item-resolved",
  "onboarding",
]);
const SQUIRE_KINDS: ReadonlySet<string> = new Set([
  "turn-finished",
  "thread-stopped",
  "waiting-on-user",
  "pull-request-changed",
  "voice-note",
  "routed-task",
  "schedule-due",
  "webhook-received",
  "message",
]);

/** Keyed by home generation: a batch reset by a re-home gets a new command id on the new home. */
export const batchIdFor = (
  squire: Pick<SquireRow, "id" | "home_generation">,
  rows: ReadonlyArray<SquireEventRow>,
) => `${squire.id}-g${squire.home_generation}-${Math.min(...rows.map((row) => row.id))}`;
export const deliverCommandId = (batchId: string) =>
  CommandId.make(`server:squire:deliver:${batchId}`);
export const deliverMessageId = (origin: SquireTurnOrigin, batchId: string) =>
  MessageId.make(`${MESSAGE_PREFIX}${origin}:${batchId}`);

/** The origin and batch a Squire-dispatched message id names; None for a user's own message. */
export function parseSquireMessageId(
  messageId: string,
): Option.Option<{ readonly origin: string; readonly batchId: string }> {
  if (!messageId.startsWith(MESSAGE_PREFIX)) return Option.none();
  const rest = messageId.slice(MESSAGE_PREFIX.length);
  const colon = rest.indexOf(":");
  return colon <= 0
    ? Option.none()
    : Option.some({ origin: rest.slice(0, colon), batchId: rest.slice(colon + 1) });
}

const isTestRow = (row: SquireEventRow) => row.state_key.startsWith("test:");
const VOICE_FAILING_CHECKS = 3;
// Their origin downgrade must cover exactly that input. A routed task
// too, so the cards and quiet row of its turn name only it.
const deliveredAlone = (row: SquireEventRow) =>
  row.kind === "voice-note" ||
  row.kind === "webhook-received" ||
  row.kind === "routed-task" ||
  isTestRow(row);

/** The next batch from ready rows, oldest first. */
function chooseBatch(ready: ReadonlyArray<SquireEventRow>): ReadonlyArray<SquireEventRow> {
  const first = ready[0];
  if (!first) return [];
  if (deliveredAlone(first)) return [first];
  const messages = first.kind === "message";
  return ready.filter((row) => !deliveredAlone(row) && (row.kind === "message") === messages);
}

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(SquireEvent));
const decodePayload = Schema.decodeUnknownOption(SquireEventPayloadJson);
const decodeBudgets = Schema.decodeUnknownOption(Schema.fromJsonString(SquireBudgets));
const encodeCardPayload = Schema.encodeSync(Schema.fromJsonString(SquireCardPayload));
const encodeCardTrigger = Schema.encodeSync(Schema.fromJsonString(SquireCardTrigger));

type KnownEvent = Exclude<SquireEvent, UnknownUnionMember>;
type OtherEvent = Extract<SquireBatchEvent, { readonly kind: "event" }>["event"];
const isOtherEvent = (event: KnownEvent): event is OtherEvent => !isSummaryBearing(event.type);
const encodeLogData = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const knownEvent = (row: SquireEventRow): Option.Option<KnownEvent> =>
  Option.filter(
    decodeEvent(row.payload_json ?? ""),
    (event): event is KnownEvent => !isUnknownUnionMember(event),
  );

/** A message's sender, or the Lead for a routed task. */
function senderOf(row: SquireEventRow, leadId: SquireId | null): string | null {
  const event = Option.getOrNull(knownEvent(row));
  if (event === null) return null;
  if (event.type === "routed-task") return leadId;
  if (event.type !== "message") return null;
  return event.from.kind === "squire" || event.from.kind === "lead"
    ? event.from.squireId
    : event.from.kind;
}

/** Whether a voice batch's speaker was verified (every note's); undefined for other batches. */
export function batchSpeakerVerified(rows: ReadonlyArray<SquireEventRow>): boolean | undefined {
  if (batchOrigin(rows) !== "voice") return undefined;
  return rows.every((row) => {
    if (row.kind !== "voice-note") return true;
    const event = Option.getOrNull(knownEvent(row));
    return event?.type === "voice-note" && event.speakerVerified;
  });
}

/** Origins that may act on Auto or rules; another Squire's words in the context demote them. */
const ACTING_ORIGINS: ReadonlySet<SquireTurnOrigin> = new Set(["event", "room", "lead"]);

/**
 * Text a Squire wrote never drives Auto or a rule, directly or through the
 * Lead. A Lead message keeps `lead` only when its key is in
 * `userStartedLeadKeys` (a user started the Lead turn that sent it);
 * otherwise it counts as a Squire's. Room context reaches the model as input
 * too, so a Squire-written post in it makes the batch `message`.
 */
export function batchOrigin(
  rows: ReadonlyArray<SquireEventRow>,
  roomContext: ReadonlyArray<Pick<RoomContextBlock, "posts">> = [],
  userStartedLeadKeys: ReadonlySet<string> = new Set(),
): SquireTurnOrigin {
  const origin = rowsOrigin(rows, userStartedLeadKeys);
  return ACTING_ORIGINS.has(origin) && hasSquireAuthoredPost(roomContext) ? "message" : origin;
}

// Lead events that carry a Squire's own words: its item's title and why, its room pitch.
const SQUIRE_WRITTEN_KINDS: ReadonlySet<string> = new Set(["room-proposed", "item-raised"]);

function rowsOrigin(
  rows: ReadonlyArray<SquireEventRow>,
  userStartedLeadKeys: ReadonlySet<string>,
): SquireTurnOrigin {
  const first = rows[0];
  if (first && isTestRow(first)) return "test";
  if (first?.kind === "voice-note") return "voice";
  if (first?.kind === "webhook-received") return "webhook";
  if (rows.some((row) => row.kind === "sweep-due")) return "sweep";
  if (rows.some((row) => SQUIRE_WRITTEN_KINDS.has(row.kind))) return "message";
  if (rows.length > 0 && rows.every((row) => row.kind === "message")) {
    const authors = rows.map((row) => {
      const event = Option.getOrNull(knownEvent(row));
      if (event?.type !== "message") return "unknown";
      if (event.from.kind === "lead" && !userStartedLeadKeys.has(event.messageKey)) return "squire";
      return event.from.kind;
    });
    if (authors.every((kind) => kind === "user")) return "room";
    if (authors.every((kind) => kind === "lead" || kind === "user")) return "lead";
    return "message";
  }
  return "event";
}

/** The PR overlay an event renders over its run summary. */
export const toSummaryPullRequest = (
  pr: SquireEventPullRequest,
  summary: SquireTurnSummary | null,
): NonNullable<SquireTurnSummary["pullRequest"]> => {
  const known = summary?.pullRequest;
  return {
    repository: pr.repository,
    number: pr.number,
    headSha: pr.headSha,
    transition: pr.transition,
    baseBranch: pr.baseBranch,
    checks:
      known && known.number === pr.number && known.headSha === pr.headSha
        ? known.checks
        : { passed: 0, failed: 0, failingJobs: [] },
    review: pr.reviewDecision ?? "none",
    mergeable: squireMergeableFromSnapshot({
      state: pr.state,
      checksState: pr.checksState,
      reviewDecision: pr.reviewDecision,
      ...(pr.mergeability === null ? {} : { mergeability: pr.mergeability }),
    }),
    merged: pr.state === "merged",
    closed: pr.state === "closed",
  };
};

const summaryStage = (row: SquireEventRow, payload: SquireEventPayload) => {
  if (row.kind === "waiting-on-user" && payload.pendingRequest) {
    return `request:${payload.pendingRequest.requestId}` as const;
  }
  return row.kind === "pull-request-changed" ? undefined : ("terminal" as const);
};

const HANDOFF_BODY_CHARS = 120;
// A space's or saga's projects in the header; the rest are counted.
const CONTAINER_MEMBERS_SHOWN = 6;
const cutLine = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository;
  const rooms = yield* SquireRoomStore.SquireRoomStore;
  const summaries = yield* SquireSummaries;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fibers = yield* FiberSet.make();
  const spaceLock = yield* Effect.serviceOption(StaveSpaceLock.StaveSpaceLock);
  const containers = yield* Effect.serviceOption(SquireContainers.SquireContainers);
  const fixtureStave = yield* Effect.serviceOption(SquireContainers.SquireFixtureStave);

  const locks = new Map<SquireId, Semaphore.Semaphore>();
  const lockFor = (squireId: SquireId) => {
    let lock = locks.get(squireId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(squireId, lock);
    }
    return lock;
  };
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const projectTitle = (projectId: ProjectId) =>
    projects.getShell(projectId).pipe(Effect.map((shell) => Option.getOrNull(shell)?.title ?? ""));
  const threadTitle = (threadId: ThreadId) =>
    projections
      .getThreadShell(threadId)
      .pipe(Effect.map((shell) => (shell ? shell.title : threadId)));

  /**
   * The header's scope line. A space or saga shows the name the Squire views
   * show and the projects it holds; a project inside a saga names that saga,
   * so the model can tie an event's project to the saga it was asked about.
   */
  const trackedNames = Effect.fn("SquireDelivery.trackedNames")(function* (squireId: SquireId) {
    const grants = yield* repository.listGrants(squireId);
    const needsShells = grants.some(
      (grant) =>
        grant.kind === "project" || grant.kind === "staveSpace" || grant.kind === "staveSaga",
    );
    const usesStave = grants.some(
      (grant) => grant.kind === "staveSpace" || grant.kind === "staveSaga",
    );
    const shells = needsShells ? yield* projects.listShells() : [];
    const nameOf = (containerId: string) =>
      SquireContainers.staveContainerName(shells, fixtureStave, containerId).pipe(
        Effect.map(Option.getOrElse(() => containerId)),
      );
    // Every project for a space or saga grant (to list its projects), else only the granted ones.
    const granted = new Set(
      grants.filter((grant) => grant.kind === "project").map((g) => g.target_id),
    );
    const memberships = new Map<ProjectId, { spaceId: string | null; sagaId: string | null }>();
    if (Option.isSome(containers)) {
      for (const shell of shells) {
        if (!usesStave && !granted.has(shell.id)) continue;
        const membership = yield* containers.value.ofProject(shell.id);
        if (membership.status === "known") memberships.set(shell.id, membership);
      }
    }
    const membersOf = (containerId: string, kind: "staveSpace" | "staveSaga") =>
      shells
        .filter((shell) => {
          const membership = memberships.get(shell.id);
          return kind === "staveSaga"
            ? membership?.sagaId === containerId
            : membership?.spaceId === containerId;
        })
        .map((shell) => shell.title);
    const named: Array<{ readonly kind: SquireGrantKind; readonly name: string }> = [];
    for (const grant of grants) {
      switch (grant.kind) {
        case "project": {
          const projectId = ProjectId.make(grant.target_id);
          const title = (yield* projectTitle(projectId)) || grant.target_id;
          const sagaId = memberships.get(projectId)?.sagaId ?? null;
          named.push({
            kind: grant.kind,
            name: sagaId === null ? title : `${title} (in saga ${yield* nameOf(sagaId)})`,
          });
          break;
        }
        case "thread":
        case "exclusion":
          named.push({
            kind: grant.kind,
            name: yield* threadTitle(ThreadId.make(grant.target_id)),
          });
          break;
        case "staveSpace":
        case "staveSaga": {
          const members = membersOf(grant.target_id, grant.kind);
          const shown = members.slice(0, CONTAINER_MEMBERS_SHOWN);
          const more = members.length - shown.length;
          named.push({
            kind: grant.kind,
            name:
              members.length === 0
                ? yield* nameOf(grant.target_id)
                : `${yield* nameOf(grant.target_id)} (projects: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""})`,
          });
          break;
        }
      }
    }
    return named;
  });

  const budgetState = Effect.fn("SquireDelivery.budgetState")(function* (squire: SquireRow) {
    const budgets = Option.getOrElse(
      decodeBudgets(squire.budgets_json),
      () => DEFAULT_SQUIRE_BUDGETS,
    );
    const now = yield* DateTime.now;
    const usage = yield* repository.listBudgetUsage({
      squireId: squire.id,
      since: DateTime.formatIso(DateTime.subtract(now, { milliseconds: DAY_MS })),
    });
    const used = (kind: string) => usage.filter((row) => row.kind === kind).length;
    return {
      steers: { used: used("steer"), limit: budgets.steersPerDay },
      threads: { used: used("thread"), limit: budgets.threadsPerDay },
      messages: { used: used("message"), limit: budgets.messagesPerDay },
    };
  });

  const threadEntry = Effect.fn("SquireDelivery.threadEntry")(function* (row: SquireEventRow) {
    if (!isSummaryBearing(row.kind) || row.thread_id === null) return null;
    const threadId = row.thread_id;
    const payload = Option.getOrNull(decodePayload(row.payload_json ?? ""));
    let summary: SquireTurnSummary | null = null;
    if (payload?.runId) {
      const stage = summaryStage(row, payload);
      const stored = yield* summaries.read({
        threadId,
        runId: payload.runId,
        ...(stage === undefined ? {} : { stage }),
      });
      // A summary not settled by now delivers with its deterministic fields.
      summary = Option.match(stored, {
        onNone: () => null,
        onSome: (value) =>
          value.status === "complete"
            ? value.summary
            : { ...value.summary, summaryStatus: "partial" as const },
      });
    }
    const shell = yield* projections.getThreadShell(threadId);
    const now = yield* DateTime.now;
    const pending = payload?.pendingRequest ?? null;
    const createdAt = pending ? DateTime.make(pending.createdAt) : Option.none();
    return {
      kind: row.kind,
      threadId,
      threadTitle: summary?.threadTitle ?? shell?.title ?? threadId,
      project: summary?.project ?? (shell ? yield* projectTitle(shell.projectId) : ""),
      summary,
      overlay: {
        ...(payload?.outcome ? { outcome: payload.outcome } : {}),
        ...(pending?.question ? { pendingQuestion: pending.question } : {}),
        ...(payload?.pullRequest
          ? { pullRequest: toSummaryPullRequest(payload.pullRequest, summary) }
          : {}),
      },
      ...(payload?.evidence === undefined ? {} : { evidence: payload.evidence }),
      ...(payload?.pullRequest?.threadSelfWatching === true ? { threadSelfWatching: true } : {}),
      ...(row.kind === "waiting-on-user" && Option.isSome(createdAt)
        ? {
            waitingMinutes: Math.max(
              0,
              Math.floor(
                (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(createdAt.value)) / 60_000,
              ),
            ),
          }
        : {}),
    } satisfies SquireBatchEvent;
  });

  // Lecturn: a voice note carries no job name, so its batch names the latest
  // failing check of each thread the Squire has heard about; one the note
  // already names is left out.
  const voiceFailingChecks = Effect.fn("SquireDelivery.voiceFailingChecks")(function* (
    squireId: SquireId,
    transcript: string,
  ) {
    const rows = yield* repository.listEventsByStatus({
      squireId,
      statuses: ["delivered", "batched", "pending"],
    });
    const seen = new Set<ThreadId>();
    const checks: Array<SquireBatchFailingCheck> = [];
    const spoken = transcript.toLowerCase();
    for (const row of rows.toReversed()) {
      if (checks.length >= VOICE_FAILING_CHECKS) break;
      if (row.thread_id === null || seen.has(row.thread_id)) continue;
      const payload = Option.getOrNull(decodePayload(row.payload_json ?? ""));
      if (payload === null) continue;
      const summary = payload.runId
        ? Option.getOrNull(yield* summaries.read({ threadId: row.thread_id, runId: payload.runId }))
            ?.summary
        : undefined;
      const evidence = payload.evidence;
      const pullRequest = evidence?.pullRequest ?? summary?.pullRequest ?? null;
      const check = evidence?.ciLog?.jobs[0]?.name ?? pullRequest?.checks.failingJobs[0];
      // The thread's newest row with any check state decides: a later pass clears it.
      if (check === undefined && pullRequest === null && payload.pullRequest?.checksState == null)
        continue;
      seen.add(row.thread_id);
      if (check === undefined || spoken.includes(check.toLowerCase())) continue;
      const number = payload.pullRequest?.number ?? pullRequest?.number;
      const errorLine = evidence?.errorLines?.find((line) => line.trim().length > 0);
      checks.push({
        threadId: row.thread_id,
        threadTitle: summary?.threadTitle ?? (yield* threadTitle(row.thread_id)),
        check,
        ...(number === undefined ? {} : { pullRequestNumber: number }),
        ...(errorLine === undefined ? {} : { errorLine }),
      });
    }
    return checks;
  });

  const renderBatch = Effect.fn("SquireDelivery.renderBatch")(function* (
    squire: SquireRow,
    rows: ReadonlyArray<SquireEventRow>,
    origin: SquireTurnOrigin,
    roomContext: ReadonlyArray<RoomContextBlock>,
  ) {
    const events: Array<SquireBatchEvent> = [];
    const named = new Set<SquireId>();
    for (const row of rows) {
      const thread = yield* threadEntry(row);
      if (thread) {
        events.push(thread);
        continue;
      }
      const event = Option.getOrNull(knownEvent(row));
      if (event === null || !isOtherEvent(event)) continue;
      const failingChecks =
        event.type === "voice-note" ? yield* voiceFailingChecks(squire.id, event.transcript) : [];
      events.push({ kind: "event", event, ...(failingChecks.length > 0 ? { failingChecks } : {}) });
      if (event.type === "message" && event.from.kind === "squire") named.add(event.from.squireId);
      if (event.type === "item-raised" || event.type === "item-resolved") {
        named.add(event.squireId);
      }
      if (event.type === "room-proposed") {
        named.add(event.fromSquireId);
        for (const member of event.members) named.add(member);
      }
    }
    const squireNames: Record<string, string> = {};
    for (const id of named) {
      const other = yield* repository.getSquire(id);
      if (Option.isSome(other)) squireNames[id] = other.value.name;
    }
    return renderSquireEventBatchShown({
      brief: squire.brief,
      origin,
      budget: yield* budgetState(squire),
      tracked: yield* trackedNames(squire.id),
      events,
      squireNames,
      roomContext,
    });
  });

  /** One bot-authored message reads as "<Sender> → <Recipient>: <first line>". */
  const handoffSummary = Effect.fn("SquireDelivery.handoffSummary")(function* (
    squire: SquireRow,
    rows: ReadonlyArray<SquireEventRow>,
  ) {
    const [only, ...rest] = rows;
    if (only === undefined || rest.length > 0) return null;
    const event = Option.getOrNull(knownEvent(only));
    if (event?.type !== "message" || (event.from.kind !== "squire" && event.from.kind !== "lead")) {
      return null;
    }
    const sender = yield* repository.getSquire(event.from.squireId);
    const senderName = Option.isSome(sender) ? sender.value.name : event.from.squireId;
    const line =
      event.body
        .split("\n")
        .find((entry) => entry.trim().length > 0)
        ?.trim() ?? "";
    return `${senderName} → ${squire.name}: ${cutLine(line, HANDOFF_BODY_CHARS)}`;
  });

  const senderThreadOf = Effect.fn("SquireDelivery.senderThreadOf")(function* (
    rows: ReadonlyArray<SquireEventRow>,
  ) {
    if (!rows.some((row) => row.kind === "message" || row.kind === "routed-task")) return null;
    const lead = yield* repository.getLead;
    const leadId = Option.isSome(lead) ? lead.value.id : null;
    const senders = new Set(
      rows
        .filter((row) => row.kind === "message" || row.kind === "routed-task")
        .map((row) => senderOf(row, leadId)),
    );
    // A multi-sender batch names each sender in its text and links none.
    const [only] = senders;
    if (senders.size !== 1 || only === null || only === undefined) return null;
    if (only === "user" || only === "system") return null;
    const sender = yield* repository.getSquire(only as SquireId);
    return Option.isSome(sender) ? sender.value.home_thread_id : null;
  });

  /**
   * Follows the operation's end rather than a timer: queues for the space
   * shared, so it never blocks a user turn and FIFO keeps the operation fair,
   * then lets go before the resend, which goes through normal admission.
   */
  const retryWhenSpaceFrees = Effect.fn("SquireDelivery.retryWhenSpaceFrees")(function* (
    squireId: SquireId,
    homeThreadId: ThreadId,
  ) {
    yield* Effect.logDebug("Squire delivery waits for the Stave space lock", { squireId });
    if (Option.isNone(spaceLock)) return;
    const shell = yield* projections.getThreadShell(homeThreadId);
    if (!shell) return;
    const project = yield* projects.get(shell.projectId, { includeDeleted: true });
    if (Option.isNone(project)) return;
    yield* FiberSet.run(
      fibers,
      spaceLock.value
        .withSharedSpaceLock(project.value.workspaceRoot, Effect.void)
        .pipe(Effect.andThen(wake(squireId))),
    );
  });

  const originOf = (
    rows: ReadonlyArray<SquireEventRow>,
    roomContext: ReadonlyArray<RoomContextBlock>,
  ) =>
    userStartedLeadKeys(repository, rows).pipe(
      Effect.map((keys) => batchOrigin(rows, roomContext, keys)),
    );

  /** The room context a batched batch stored, rebuilt after its cursors moved. */
  const storedContext = (squire: SquireRow, batchId: string, rows: ReadonlyArray<SquireEventRow>) =>
    readRoomContextWindows(repository, { squireId: squire.id, batchId, batch: rows }).pipe(
      Effect.flatMap((windows) => roomContextFromWindows({ repository, rooms }, windows)),
    );

  const dispatchBatch = Effect.fn("SquireDelivery.dispatchBatch")(function* (
    squire: SquireRow,
    homeThreadId: ThreadId,
    batchId: string,
    rows: ReadonlyArray<SquireEventRow>,
    // Absent on a re-dispatch: the window the first attempt stored is shown again.
    shown?: { readonly origin: SquireTurnOrigin; readonly text: string },
  ) {
    const { origin, text } =
      shown ??
      (yield* Effect.gen(function* () {
        const context = yield* storedContext(squire, batchId, rows);
        const stored = yield* originOf(rows, context);
        return { origin: stored, text: (yield* renderBatch(squire, rows, stored, context)).text };
      }));
    const senderThreadId = yield* senderThreadOf(rows);
    const handoff = yield* handoffSummary(squire, rows);
    const kinds = rows.map((row) => row.kind);
    const command = {
      type: "message.dispatch",
      commandId: deliverCommandId(batchId),
      threadId: homeThreadId,
      messageId: deliverMessageId(origin, batchId),
      ...(senderThreadId === null ? {} : { senderThreadId }),
      text,
      attachments: [],
      notification: {
        source: {
          kind: "squire",
          squireId: squire.id,
          eventCount: rows.length,
          eventKinds: kinds,
        },
        outcome: "updated",
        summary:
          handoff ??
          `${rows.length} Squire event${rows.length === 1 ? "" : "s"}: ${[...new Set(kinds)].join(
            ", ",
          )}`,
      },
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    } satisfies OrchestrationV2ServerCommand;
    const dispatch = withSquireDispatchOrigin(orchestrator.dispatch(command));
    // A first refusal surfaces as a dispatch error with its rejected receipt
    // committed; the replay reads that receipt, while a storage failure that
    // committed nothing simply tries again.
    const refusal = yield* dispatch.pipe(
      Effect.catchTags({ OrchestratorDispatchError: () => dispatch }),
      Effect.as(Option.none<Orchestrator.OrchestratorV2Error>()),
      Effect.catchIf(
        (error) => TERMINAL_DISPATCH_ERRORS.has(error._tag),
        (error) => Effect.succeedSome(error),
      ),
    );
    if (Option.isNone(refusal)) return "dispatched" as const;
    if (isSpaceBusy(refusal.value)) {
      // Nothing committed: the rows stay batched under their stored room
      // window, and the next attempt resends this command id.
      yield* retryWhenSpaceFrees(squire.id, homeThreadId);
      return "contended" as const;
    }
    // Retrying would loop on every wake: the batch is dropped and logged, and
    // the room cursors it advanced go back so its context rides the next batch.
    yield* repository.transaction(
      Effect.gen(function* () {
        const windows = yield* readRoomContextWindows(repository, {
          squireId: squire.id,
          batchId,
          batch: rows,
        });
        const dropped = yield* repository.dropBatch(batchId);
        if (dropped === 0) return;
        yield* rewindRoomCursors(rooms, { squireId: squire.id, role: squire.role, windows });
        yield* repository.insertActionLog({
          squire_id: squire.id,
          kind: "notification.delivery",
          room_id: null,
          post_id: null,
          trigger_id: null,
          task_id: null,
          thread_id: homeThreadId,
          card_id: null,
          event_id: null,
          run_id: null,
          invocation_key: null,
          execution_key: null,
          data_json: encodeLogData({
            batchId,
            outcome: "rejected",
            reason: refusal.value.message,
          }),
          created_at: yield* nowIso,
        });
      }),
    );
    yield* Effect.logWarning("Squire delivery refused; batch dropped", {
      squireId: squire.id,
      batchId,
      error: refusal.value._tag,
      // The rejected command never committed a receipt, so this is the only record of why.
      cause: "cause" in refusal.value ? refusal.value.cause : undefined,
    });
    return "refused" as const;
  });

  const receives = (squire: SquireRow, kind: string) =>
    squire.role === "lead" ? LEAD_KINDS.has(kind) : SQUIRE_KINDS.has(kind);
  // Leaves a newer server's kinds alone instead of dropping them.
  const knownKind = (kind: string) => LEAD_KINDS.has(kind) || SQUIRE_KINDS.has(kind);

  /** Callers hold the Squire's lock. Only rows this call moves get FYIs, so a repeat writes none. */
  const finalizeBatch = (squire: SquireRow, batchId: string, runId: RunId) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* repository.transaction(
        Effect.gen(function* () {
          const delivered = yield* repository.markBatchDelivered(batchId);
          // The latest summary-bearing event per thread; a newer FYI would replace earlier ones.
          const latest = new Map<ThreadId, SquireEventRow>();
          for (const row of delivered) {
            // A waiting-on-user event raises its own question card.
            if (!isSummaryBearing(row.kind) || row.kind === "waiting-on-user") continue;
            if (row.thread_id !== null) latest.set(row.thread_id, row);
          }
          for (const [threadId, row] of latest) {
            const decided = yield* repository.runRaisedDecisionCard({
              squireId: squire.id,
              runId,
              threadId,
            });
            if (!decided) yield* writeFyi({ squire, runId, row, now });
          }
        }),
      );
    });

  /**
   * Callers hold the Squire's lock. A refused batch is dropped and the next
   * one tried; one Stave turned away for a busy space waits for it instead.
   */
  const deliverNext = (squireId: SquireId): Effect.Effect<void, SquireDeliveryError> =>
    Effect.gen(function* () {
      const found = yield* repository.getSquire(squireId);
      if (Option.isNone(found)) return;
      const squire = found.value;
      const homeThreadId = squire.home_thread_id;
      if (squire.status !== "active" || squire.lifecycle !== "ready" || homeThreadId === null) {
        return;
      }
      const rows = yield* repository.listEventsByStatus({
        squireId,
        statuses: ["pending", "batched"],
      });
      if (rows.length === 0) return;
      const shell = yield* projections.getThreadShell(homeThreadId);
      // A `waiting` run is still active, so the busy check reads activityRunStatus.
      if (!shell || shell.archivedAt !== null || shell.activityRunStatus != null) return;

      // One batch in flight. Its run's end normally finalizes it; an idle
      // thread with the batch unfinished means that report was missed, or
      // the dispatch never committed.
      const outstanding = rows.filter((row) => row.status === "batched");
      const outstandingId = outstanding[0]?.batch_id;
      if (outstandingId) {
        const context = yield* storedContext(squire, outstandingId, outstanding);
        const origin = yield* originOf(outstanding, context);
        const messageId = deliverMessageId(origin, outstandingId);
        const { messages } = yield* projections.getThreadRecords(homeThreadId, ["messages"], {
          messageIds: [messageId],
        });
        const runId = messages[0]?.runId ?? null;
        if (messages.length === 0) {
          const { text } = yield* renderBatch(squire, outstanding, origin, context);
          const outcome = yield* dispatchBatch(squire, homeThreadId, outstandingId, outstanding, {
            origin,
            text,
          });
          if (outcome !== "refused") return;
        } else {
          if (runId === null) return;
          const { runs } = yield* projections.getThreadRecords(homeThreadId, ["runs"], {
            runIds: [runId],
          });
          if (!runs.some((run) => TERMINAL_RUN_STATUSES.has(run.status))) return;
          yield* finalizeBatch(squire, outstandingId, runId);
        }
      }

      const pending = rows.filter((row) => row.status === "pending");
      const unwanted = pending.filter((row) => knownKind(row.kind) && !receives(squire, row.kind));
      yield* repository.dropPendingEvents(unwanted.map((row) => row.id));
      const ready = pending.filter((row) => receives(squire, row.kind));
      if (ready.length === 0) return;

      const batch = chooseBatch(ready);
      const batchId = batchIdFor(squire, batch);
      const now = yield* nowIso;
      // Context rides a batch that exists anyway; it never wakes a member.
      const collected = yield* collectRoomContext({ repository, rooms }, { squire, batch });
      // Rendered first, so only rooms whose posts reached the text advance;
      // a cut room keeps its cursor and its posts ride the next batch.
      const leadKeys = yield* userStartedLeadKeys(repository, batch);
      let origin = batchOrigin(batch, collected, leadKeys);
      let rendered = yield* renderBatch(squire, batch, origin, collected);
      let context = collected.filter((block) => rendered.roomsShown.includes(block.roomId));
      // The origin follows what was shown, so a re-dispatch from the stored
      // windows names the same message id. A demotion only a cut room caused
      // is undone; the shorter header still fits every room shown.
      if (batchOrigin(batch, context, leadKeys) !== origin) {
        origin = batchOrigin(batch, context, leadKeys);
        rendered = yield* renderBatch(squire, batch, origin, context);
        context = context.filter((block) => rendered.roomsShown.includes(block.roomId));
      }
      const marked = yield* repository.transaction(
        Effect.gen(function* () {
          const count = yield* repository.markEventsBatched({
            ids: batch.map((row) => row.id),
            batchId,
          });
          if (count === 0) return count;
          yield* advanceRoomCursors(rooms, {
            squireId,
            role: squire.role,
            blocks: context,
          });
          const firstId = Math.min(...batch.map((row) => row.id));
          for (const row of batch) {
            yield* repository.insertActionLog({
              squire_id: squireId,
              kind: "event.received",
              room_id: null,
              post_id: null,
              trigger_id: null,
              task_id: null,
              thread_id: row.thread_id,
              card_id: null,
              event_id: row.id,
              run_id: null,
              invocation_key: null,
              execution_key: null,
              data_json: encodeLogData({
                batchId,
                kind: row.kind,
                ...(row.id === firstId && context.length > 0
                  ? { [ROOM_CONTEXT_LOG_KEY]: encodeRoomContextWindows(context) }
                  : {}),
              }),
              created_at: now,
            });
          }
          return count;
        }),
      );
      if (marked === 0) return;
      const outcome = yield* dispatchBatch(squire, homeThreadId, batchId, batch, {
        origin,
        text: rendered.text,
      });
      if (outcome === "refused") yield* deliverNext(squireId);
    });

  const deliverReady: SquireDelivery["Service"]["deliverReady"] = (squireId) =>
    lockFor(squireId).withPermits(1)(deliverNext(squireId));

  const writeFyi = Effect.fn("SquireDelivery.writeFyi")(function* (input: {
    readonly squire: SquireRow;
    readonly runId: RunId;
    readonly row: SquireEventRow;
    readonly now: string;
  }) {
    const { squire, row, now } = input;
    const threadId = row.thread_id;
    if (threadId === null) return;
    const payload = Option.getOrNull(decodePayload(row.payload_json ?? ""));
    const shell = yield* projections.getThreadShell(threadId);
    const title = shell?.title ?? threadId;
    const outcome = payload?.outcome ?? row.kind;
    const text = `${title}: ${outcome}`;
    // The card keys the summary (thread, run, stage) instead of copying it.
    const trigger = encodeCardTrigger({
      ...(payload?.runId ? { runId: payload.runId } : {}),
      ...(payload?.pendingRequest ? { requestId: payload.pendingRequest.requestId } : {}),
      ...(payload?.pullRequest
        ? {
            prKey: `${payload.pullRequest.host}/${payload.pullRequest.repository}#${payload.pullRequest.number}`,
            headSha: payload.pullRequest.headSha,
            transition: payload.pullRequest.transition,
          }
        : {}),
    });
    const cardPayload = encodeCardPayload({ type: "fyi", source: "summary", text, threadId });
    const open = yield* repository.listCards({
      squireId: squire.id,
      statuses: ["open"],
      targetThreadId: threadId,
      kinds: ["fyi"],
    });
    const existing = open[0];
    let cardId: SquireCardId;
    if (existing) {
      // One open item per (Squire, thread, type); the newer one replaces it.
      yield* repository.updateCard({
        id: existing.id,
        fromStatuses: ["open"],
        patch: {
          title,
          payload_json: cardPayload,
          trigger_json: trigger,
          replaced_count: existing.replaced_count + 1,
        },
        updatedAt: now,
      });
      cardId = existing.id;
    } else {
      cardId = SquireCardId.make(`fyi:${squire.id}:${row.id}`);
      yield* repository.insertCard({
        id: cardId,
        squire_id: squire.id,
        owner_squire_id: squire.id,
        kind: "fyi",
        status: "open",
        target_thread_id: threadId,
        project_id: shell?.projectId ?? null,
        title,
        why: "",
        payload_json: cardPayload,
        evidence_json: "{}",
        trigger_json: trigger,
        intent_json: null,
        origin: "event",
        steer_kind: null,
        routed_task_id: null,
        rule_id: null,
        finding_key: null,
        escalate_at: null,
        opened_at: null,
        executes_at: null,
        attempt: 0,
        command_id: null,
        execution_key: null,
        dedupe_key: null,
        replaced_count: 0,
        ask_json: null,
        resolution: null,
        created_at: now,
        updated_at: now,
      });
    }
    yield* repository.insertActionLog({
      squire_id: squire.id,
      kind: "card.created",
      room_id: null,
      post_id: null,
      trigger_id: null,
      task_id: null,
      thread_id: threadId,
      card_id: cardId,
      event_id: row.id,
      run_id: input.runId,
      invocation_key: null,
      execution_key: null,
      data_json: encodeLogData({ kind: "fyi", source: "summary" }),
      created_at: now,
    });
  });

  const wake: SquireDelivery["Service"]["wake"] = (squireId) =>
    FiberSet.run(
      fibers,
      deliverReady(squireId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire delivery failed", { squireId, cause }),
        ),
      ),
    ).pipe(Effect.asVoid);

  const finalizeRun: SquireDelivery["Service"]["finalizeRun"] = (input) =>
    Effect.gen(function* () {
      const { runs } = yield* projections.getThreadRecords(input.homeThreadId, ["runs"], {
        runIds: [input.runId],
      });
      const run = runs.find((entry) => entry.id === input.runId);
      const parsed = run ? parseSquireMessageId(run.userMessageId) : Option.none();
      const found = yield* repository.getSquire(input.squireId);
      if (Option.isSome(parsed) && Option.isSome(found)) {
        yield* lockFor(input.squireId).withPermits(1)(
          finalizeBatch(found.value, parsed.value.batchId, input.runId),
        );
      }
      yield* wake(input.squireId);
    });

  const redispatchBatched: SquireDelivery["Service"]["redispatchBatched"] = Effect.gen(
    function* () {
      const rows = yield* repository.listBatchedEvents;
      const batches = new Map<string, Array<SquireEventRow>>();
      for (const row of rows) {
        if (row.batch_id === null) continue;
        const batch = batches.get(row.batch_id) ?? [];
        batch.push(row);
        batches.set(row.batch_id, batch);
      }
      for (const [batchId, batch] of batches) {
        const squireId = batch[0]!.squire_id;
        yield* lockFor(squireId).withPermits(1)(
          Effect.gen(function* () {
            const found = yield* repository.getSquire(squireId);
            if (Option.isNone(found) || found.value.home_thread_id === null) return;
            const squire = found.value;
            const homeThreadId = found.value.home_thread_id;
            // A committed dispatch is reconciled whatever the Squire's state:
            // a run that ended while the server was down is finalized here,
            // and a live one finalizes at its end.
            const context = yield* storedContext(squire, batchId, batch);
            const origin = yield* originOf(batch, context);
            const { messages } = yield* projections.getThreadRecords(homeThreadId, ["messages"], {
              messageIds: [deliverMessageId(origin, batchId)],
            });
            if (messages.length > 0) {
              const runId = messages[0]?.runId ?? null;
              if (runId === null) return;
              const { runs } = yield* projections.getThreadRecords(homeThreadId, ["runs"], {
                runIds: [runId],
              });
              if (!runs.some((run) => TERMINAL_RUN_STATUSES.has(run.status))) return;
              yield* finalizeBatch(squire, batchId, runId);
              yield* wake(squireId);
              return;
            }
            // An uncommitted one is a new turn: it passes the same admission
            // as any delivery, and waits batched for the resume's wake.
            if (squire.status !== "active" || squire.lifecycle !== "ready") return;
            const outcome = yield* dispatchBatch(squire, homeThreadId, batchId, batch);
            if (outcome === "refused") yield* wake(squireId);
          }),
        );
      }
    },
  );

  return SquireDelivery.of({
    wake,
    deliverReady,
    finalizeRun,
    redispatchBatched,
    drain: FiberSet.awaitEmpty(fibers),
  });
});

// The store is stateless SQL over the shared client, so a memoized copy here
// changes nothing for the stack and spares every delivery harness the wiring.
export const layer = Layer.effect(SquireDelivery, make).pipe(Layer.provide(SquireRoomStore.layer));
