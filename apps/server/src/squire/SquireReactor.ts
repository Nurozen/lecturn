/**
 * The Squire event reactor. A durable cursor over committed application
 * events: each event is classified from its own stored payload
 * (`squireEvents.ts`), and every interested Squire gets an `INSERT OR IGNORE`
 * row, so the dedupe key makes ingestion idempotent across lag and restarts.
 * It also owns deferral promotion (summary, threshold, background), question
 * cards, card outdating, deletion cascades, and the auto-decline on Squire
 * threads. Summary generation and re-homing are forked so a slow model call
 * never holds the cursor; `drainThrough` waits for both.
 */
import {
  type ApplicationStoredEvent,
  CommandId,
  isUnknownUnionMember,
  ModelSelection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type RunId,
  SquireCardId,
  SquireCardPayload,
  SquireCardTrigger,
  SquireEventToggles,
  type SquireId,
  type SquireTurnSummary,
  ThreadId,
  type ThreadPullRequestLink,
  TurnItemId,
} from "@lecturn/contracts";
import { backgroundWorkHoldsCompletion } from "@lecturn/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestKeyOf } from "@lecturn/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TxRef from "effect/TxRef";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import { questionCardTrigger, readSquireQuestion, squireQuestionTitle } from "./SquireItems.ts";
import * as SquireLifecycle from "./SquireLifecycle.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireHooks from "./squireHooks.ts";
import * as SquireProbe from "./SquireProbe.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireScope from "./SquireScope.ts";
import * as SquireSummaries from "./SquireSummaries.ts";
import {
  classifySquireEvent,
  type SquireEventCandidate,
  type SquireEventPayload,
  SquireEventPayloadJson,
  type SquireEventPendingRequest,
  type SquireReactorEffect,
  SQUIRE_SUMMARY_WAIT_MS,
  scheduleSquireEvent,
  squireClassifyNeeds,
  squireEventToggle,
  squireInterruptActor,
  squirePullRequestRevision,
  squirePullRequestStates,
} from "./squireEvents.ts";
import { writeLeadItemEvent, writeLeadItemsResolved } from "./squireLeadItems.ts";
import { retireOutOfScope } from "./squireScopeCascade.ts";

export type SquireReactorError = SquireScope.SquireScopeError;

export class SquireReactor extends Context.Service<
  SquireReactor,
  {
    /**
     * The cursor loop for one on period; restarts from the durable cursor
     * after a storage failure. `turnedOn` when the period's cursor sync jumped
     * the cursor, so the off period's cascades are applied first.
     */
    readonly start: (input: { readonly turnedOn: boolean }) => Effect.Effect<never>;
    /** Resolves once the cursor passed `sequence` and the work it forked settled. */
    readonly drainThrough: (sequence: number) => Effect.Effect<void>;
    /**
     * Due threshold rows raise their question card and wait on their
     * provisional summary; summary rows past `not_before` turn `pending`
     * (delivery renders them partial). Returns the Squires that gained
     * `pending` rows, already woken.
     */
    readonly promoteDue: (
      now: DateTime.Utc,
    ) => Effect.Effect<ReadonlyArray<SquireId>, SquireReactorError>;
  }
>()("lecturn/squire/SquireReactor") {}

const FIXTURE_DIR = "squire-fixtures";

const slashed = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");

/** A fixture project lives in the sandbox dir `<lecturn home>/squire-fixtures/`. */
export const isFixtureWorkspaceRoot = (baseDir: string, workspaceRoot: string) =>
  slashed(workspaceRoot).startsWith(`${slashed(baseDir)}/${FIXTURE_DIR}/`);

/**
 * A thread whose project is a fixture's: only `inject` writes its rows. The
 * reactor still applies its effects (resolution, outdating, cascades).
 */
export const isFixtureOwnedThread = Effect.fn("SquireReactor.isFixtureOwnedThread")(function* (
  threadId: ThreadId,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const shell = yield* projections.getThreadShell(threadId);
  if (shell === null) return false;
  return yield* isFixtureProject(
    yield* ServerConfig.ServerConfig,
    yield* ProjectStore.ProjectStoreV2,
    shell.projectId,
  );
});

const isFixtureProject = (
  config: ServerConfig.ServerConfig["Service"],
  projects: ProjectStore.ProjectStoreV2["Service"],
  projectId: ProjectId,
) =>
  projects
    .get(projectId, { includeDeleted: true })
    .pipe(
      Effect.map(
        (project) =>
          Option.isSome(project) &&
          isFixtureWorkspaceRoot(config.baseDir, project.value.workspaceRoot),
      ),
    );

const encodePayload = Schema.encodeSync(SquireEventPayloadJson);
const decodePayload = Schema.decodeUnknownOption(SquireEventPayloadJson);
const decodeToggles = Schema.decodeUnknownOption(Schema.fromJsonString(SquireEventToggles));
const DEFAULT_TOGGLES = Schema.decodeSync(SquireEventToggles)({});
const decodeModel = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));
const encodeTrigger = Schema.encodeSync(Schema.fromJsonString(SquireCardTrigger));
const decodeTrigger = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCardTrigger));
const decodeCardPayload = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCardPayload));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Thread changes that can end an overlap item's change set. */
const THREAD_CHANGE_EVENTS: ReadonlySet<string> = new Set([
  "thread.pull-request-link-updated",
  "thread.settled",
  "thread.unsettled",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.metadata-updated",
]);

const togglesOf = (row: SquireRepository.SquireRow) =>
  Option.getOrElse(decodeToggles(row.events_json), () => DEFAULT_TOGGLES);

// Ignored events are re-read harmlessly after a restart, so the cursor is
// written after each event that did work and only every so often otherwise.
const IGNORED_CURSOR_WRITE_INTERVAL = 256;

interface InsertedRow {
  readonly id: number;
  readonly squireId: SquireId;
  readonly candidate: SquireEventCandidate;
  readonly status: SquireRepository.SquireEventRow["status"];
  readonly deferReason: SquireRepository.SquireEventRow["defer_reason"];
}

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const scope = yield* SquireScope.SquireScope;
  const summaries = yield* SquireSummaries.SquireSummaries;
  const delivery = yield* SquireDelivery.SquireDelivery;
  const lifecycle = yield* Effect.serviceOption(SquireLifecycle.SquireLifecycle);
  const rules = yield* Effect.serviceOption(SquireRules.SquireRules);
  const policyLock = yield* Effect.serviceOption(SquirePolicyLock.SquirePolicyLock);
  const probe = yield* Effect.serviceOption(SquireProbe.SquireProbe);
  // Overlap expiry follows PR, settle, archive, delete, and branch changes.
  const hooks = yield* Effect.serviceOption(SquireHooks.SquireHooks);
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const seen = yield* SubscriptionRef.make(0);
  const outstanding = yield* TxRef.make(0);
  const fibers = yield* FiberSet.make();
  const rehoming = yield* Semaphore.make(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const withPolicyLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Option.isSome(policyLock) ? policyLock.value.withPolicyLock(effect) : effect;
  const logged =
    (message: string, details: Record<string, unknown> = {}) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning(message, { ...details, cause: Cause.pretty(cause) }),
        ),
      );

  /** Off the cursor fiber, counted for `drainThrough`. */
  const fork = <E, R>(label: string, effect: Effect.Effect<void, E, R>) =>
    TxRef.update(outstanding, (n) => n + 1).pipe(
      Effect.andThen(
        FiberSet.run(fibers)(
          effect.pipe(logged(label), Effect.ensuring(TxRef.update(outstanding, (n) => n - 1))),
        ),
      ),
      Effect.asVoid,
    );
  const settled = TxRef.get(outstanding).pipe(
    Effect.flatMap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
    Effect.tx,
  );

  const wakeAll = (squireIds: Iterable<SquireId>) =>
    Effect.forEach(new Set(squireIds), (id) => delivery.wake(id), { discard: true });

  const promote = (ids: ReadonlyArray<number>) =>
    repository.setEventStatus({ ids, fromStatuses: ["deferred"], status: "pending" }).pipe(
      Effect.tap((rows) => wakeAll(rows.map((row) => row.squire_id))),
      Effect.map((rows) => rows.map((row) => row.squire_id)),
    );

  const trackersFor = (squires: ReadonlyArray<SquireRepository.SquireRow>) =>
    squires.map((row): SquireSummaries.SquireSummaryTracker => ({
      squireId: row.id,
      createdAt: row.created_at,
      active: row.status === "active",
      turnFinishedOn: togglesOf(row).turnFinished,
      summaryModelSelection: Option.getOrNull(
        row.summary_model_selection_json === null
          ? Option.none()
          : decodeModel(row.summary_model_selection_json),
      ),
    }));

  // A fixture thread's summary is the one `inject` stored, else
  // deterministic fields; it never reaches a provider.
  const fixtureSummary = (threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(
      Effect.flatMap((shell) =>
        shell === null
          ? Effect.succeed(false)
          : isFixtureProject(config, projects, shell.projectId),
      ),
      Effect.map((fixture) => (fixture ? { fixture: { summary: null } } : {})),
    );

  /** The summary is shared across Squires; once it settles its waiting rows deliver. */
  const ensureThenPromote = (
    key: SquireSummaries.SquireSummaryKey,
    squires: ReadonlyArray<SquireRepository.SquireRow>,
    rowIds: ReadonlyArray<number>,
    onSummary: (stored: SquireSummaries.SquireStoredSummary) => Effect.Effect<void> = () =>
      Effect.void,
  ) =>
    fork(
      "Squire summary ensure failed",
      fixtureSummary(key.threadId).pipe(
        Effect.flatMap((fixture) =>
          summaries.ensure({ ...key, trackers: trackersFor(squires), ...fixture }),
        ),
        Effect.flatMap(onSummary),
        // A failed summary is an honest partial; the rows deliver regardless.
        logged("Squire summary failed; delivering partial", { threadId: key.threadId }),
        Effect.andThen(rowIds.length === 0 ? Effect.void : promote(rowIds)),
      ),
    );

  const summaryKeyOf = (
    candidate: SquireEventCandidate,
    payload: SquireEventPayload,
    shell: OrchestrationV2ThreadShell | null,
  ): SquireSummaries.SquireSummaryKey | null => {
    if (payload.runId === null) return null;
    if (candidate.kind === "pull-request-changed") {
      // A live run has no terminal summary yet; delivery renders its latest provisional one.
      return shell?.activeRunId === null
        ? { threadId: candidate.threadId, runId: payload.runId, stage: "terminal" }
        : null;
    }
    return { threadId: candidate.threadId, runId: payload.runId, stage: "terminal" };
  };

  // Per-event helpers below run inside the SquireReactor.handle span.
  const ingest = Effect.fnUntraced(function* (
    candidates: ReadonlyArray<SquireEventCandidate>,
    shell: OrchestrationV2ThreadShell | null,
  ) {
    const threadId = candidates[0]?.threadId;
    if (threadId === undefined) return;
    const trackerIds = yield* scope.trackersOf(threadId);
    if (trackerIds.length === 0) return;
    if (shell !== null && (yield* isFixtureProject(config, projects, shell.projectId))) return;
    const tracking = (yield* repository.listSquires).filter(
      (row) => row.role === "squire" && trackerIds.includes(row.id),
    );
    const interested = tracking.filter(
      (row) => row.status === "active" && row.lifecycle !== "deleting",
    );
    if (interested.length === 0) return;
    const createdAt = yield* nowIso;
    const inserted: Array<InsertedRow> = [];
    for (const candidate of candidates) {
      // PR rows name the run whose summary they render.
      const payload: SquireEventPayload =
        candidate.kind === "pull-request-changed" && shell?.latestRunId
          ? { ...candidate.payload, runId: shell.latestRunId }
          : candidate.payload;
      for (const squire of interested) {
        const toggles = togglesOf(squire);
        if (!toggles[squireEventToggle(candidate.kind)]) continue;
        const schedule = scheduleSquireEvent(candidate.timing, toggles);
        const id = yield* repository.insertTriggerEvent({
          squire_id: squire.id,
          thread_id: threadId,
          kind: candidate.kind,
          state_key: candidate.stateKey,
          payload_json: encodePayload(payload),
          ...schedule,
          batch_id: null,
          created_at: createdAt,
        });
        if (Option.isSome(id)) {
          inserted.push({
            id: id.value,
            squireId: squire.id,
            candidate: { ...candidate, payload },
            status: schedule.status,
            deferReason: schedule.defer_reason,
          });
        }
      }
    }
    // Waiting rows ensure their provisional summary only once the threshold passes.
    const bySummary = new Map<
      string,
      { key: SquireSummaries.SquireSummaryKey; ids: Array<number> }
    >();
    const immediate: Array<number> = [];
    for (const row of inserted) {
      if (row.deferReason !== "summary" && row.deferReason !== "background") continue;
      const key = summaryKeyOf(row.candidate, row.candidate.payload, shell);
      if (key === null) {
        if (row.deferReason === "summary") immediate.push(row.id);
        continue;
      }
      const entry = bySummary.get(`${key.runId}:${key.stage}`) ?? { key, ids: [] };
      if (row.deferReason === "summary") entry.ids.push(row.id);
      bySummary.set(`${key.runId}:${key.stage}`, entry);
    }
    if (immediate.length > 0) yield* promote(immediate);
    for (const { key, ids } of bySummary.values()) {
      yield* ensureThenPromote(key, tracking, ids);
    }
  });

  // ── Question cards ──

  /**
   * A question says why before it is answered: the Squire's own note on
   * the thread, else the request's provisional summary, else who asked what and
   * how long ago, else how long it waited.
   */
  const questionWhy = Effect.fnUntraced(function* (
    squireId: SquireId,
    threadId: ThreadId,
    request: SquireEventPendingRequest,
    summary: SquireTurnSummary | null,
    now: DateTime.Utc,
  ) {
    const notes = (yield* repository.listCards({
      squireId,
      targetThreadId: threadId,
      kinds: ["fyi"],
      statuses: ["open"],
    })).flatMap((card) => {
      const note = Option.getOrNull(decodeCardPayload(card.payload_json));
      return note !== null && !isUnknownUnionMember(note) && note.type === "fyi"
        ? [{ source: note.source, text: note.text.trim() }]
        : [];
    });
    const note =
      notes.findLast((entry) => entry.source === "notify" && entry.text !== "") ??
      notes.findLast((entry) => entry.text !== "");
    if (note !== undefined) return note.text;
    const shell = yield* projections.getThreadShell(threadId);
    // The suggested next step is the card's recommendation, so the Why does not repeat it.
    const fromSummary = summary?.goal.trim();
    if (fromSummary) {
      // A goal that only restates the thread's title says nothing the card does not.
      const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
      if (shell === null || normalize(shell.title) !== normalize(fromSummary)) {
        return fromSummary;
      }
    }
    const elapsed = DateTime.toEpochMillis(now) - Date.parse(request.createdAt);
    const minutes = Number.isFinite(elapsed) ? Math.max(1, Math.floor(elapsed / 60_000)) : 1;
    const age =
      minutes < 60
        ? `${minutes}m`
        : minutes < 48 * 60
          ? `${Math.floor(minutes / 60)}h`
          : `${Math.floor(minutes / (24 * 60))}d`;
    // Who asked, when, and what: the evidence the card's own question line lacks.
    const thread = Option.getOrNull(
      yield* readSquireQuestion(projections, threadId, {
        requestId: request.requestId,
        secretTurnItemId:
          request.kind === "secret" ? TurnItemId.make(request.requestId) : undefined,
      }),
    );
    const asked = (request.question ?? thread?.question)?.trim().replace(/\s+/g, " ");
    if (asked) {
      const quoted = [...asked].length <= 140 ? asked : `${[...asked].slice(0, 139).join("")}…`;
      return `${shell?.title.trim() || "The thread"} asked ${age} ago: '${quoted}'`;
    }
    return `Waiting ${age} for your answer`;
  });

  // The question text and options stay on the thread; see SquireItems.
  const questionPayloadJson = (
    threadId: ThreadId,
    request: SquireEventPendingRequest,
    summary: SquireTurnSummary | null,
  ) => {
    const recommendation = summary?.suggestedNextStep?.trim();
    // The card's "waiting <age>" counts from the ask, not from when the card was raised.
    const requestedAt = DateTime.make(request.createdAt);
    return encodeJson({
      type: "question",
      threadId,
      requestKind: request.kind === "secret" ? "secret" : "runtime",
      requestId: request.requestId,
      ...(recommendation ? { recommendation } : {}),
      ...(Option.isSome(requestedAt) ? { requestedAt: DateTime.formatIso(requestedAt.value) } : {}),
    });
  };

  /** The provisional summary usually settles after the card is raised, so its Why follows. */
  const refreshQuestionWhy =
    (row: SquireRepository.SquireEventRow, request: SquireEventPendingRequest) =>
    (stored: SquireSummaries.SquireStoredSummary) =>
      Effect.gen(function* () {
        const threadId = row.thread_id!;
        const [open] = yield* repository.listCards({
          squireId: row.squire_id,
          targetThreadId: threadId,
          kinds: ["question"],
          statuses: ["open"],
        });
        if (open === undefined) return;
        const current = decodeTrigger(open.trigger_json);
        if (Option.isNone(current) || current.value.requestId !== request.requestId) return;
        const now = yield* DateTime.now;
        const why = yield* questionWhy(row.squire_id, threadId, request, stored.summary, now);
        const payloadJson = questionPayloadJson(threadId, request, stored.summary);
        if (why === open.why && payloadJson === open.payload_json) return;
        yield* repository.updateCard({
          id: open.id,
          fromStatuses: ["open"],
          patch: { why, payload_json: payloadJson },
          updatedAt: DateTime.formatIso(now),
        });
      }).pipe(logged("Squire question why failed", { threadId: row.thread_id }));

  /**
   * One open question card per (Squire, thread): a newer request
   * replaces the open one in place, counted as "updated". Never pushed.
   */
  const raiseQuestionCard = Effect.fnUntraced(function* (
    row: SquireRepository.SquireEventRow,
    payload: SquireEventPayload,
    title: string,
    projectId: ProjectId | null,
  ) {
    const request = payload.pendingRequest!;
    const threadId = row.thread_id!;
    const now = yield* nowIso;
    const stored =
      payload.runId === null
        ? Option.none()
        : yield* summaries.read({
            threadId,
            runId: payload.runId,
            stage: `request:${request.requestId}`,
          });
    const why = yield* questionWhy(
      row.squire_id,
      threadId,
      request,
      Option.isSome(stored) ? stored.value.summary : null,
      yield* DateTime.now,
    );
    const trigger = encodeTrigger(
      questionCardTrigger({
        runId: payload.runId,
        requestId: request.requestId,
        secret: request.kind === "secret",
      }),
    );
    const cardPayload = questionPayloadJson(
      threadId,
      request,
      Option.isSome(stored) ? stored.value.summary : null,
    );
    const [open] = yield* repository.listCards({
      squireId: row.squire_id,
      targetThreadId: threadId,
      kinds: ["question"],
      statuses: ["open"],
    });
    if (open !== undefined) {
      const current = decodeTrigger(open.trigger_json);
      if (Option.isSome(current) && current.value.requestId === request.requestId) {
        return Option.none<SquireId>();
      }
      yield* repository.updateCard({
        id: open.id,
        fromStatuses: ["open"],
        patch: {
          title,
          why,
          payload_json: cardPayload,
          trigger_json: trigger,
          replaced_count: open.replaced_count + 1,
        },
        updatedAt: now,
      });
      return Option.none<SquireId>();
    }
    const cardId = SquireCardId.make(
      `card:question:${row.squire_id}:${threadId}:${request.requestId}`,
    );
    if (Option.isSome(yield* repository.getCard(cardId))) return Option.none<SquireId>();
    const card: SquireRepository.SquireCardRow = {
      id: cardId,
      squire_id: row.squire_id,
      owner_squire_id: row.squire_id,
      kind: "question",
      status: "open",
      target_thread_id: threadId,
      project_id: projectId,
      title,
      why,
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
    };
    yield* repository.insertCard(card);
    yield* repository.insertActionLog({
      squire_id: row.squire_id,
      kind: "card.created",
      room_id: null,
      post_id: null,
      trigger_id: null,
      task_id: null,
      thread_id: threadId,
      card_id: cardId,
      event_id: row.id,
      run_id: null,
      invocation_key: null,
      execution_key: null,
      data_json: encodeJson({ kind: "question", source: "waiting-on-user" }),
      created_at: now,
    });
    return yield* writeLeadItemEvent(repository, { transition: "raised", card, now });
  });

  /** A due threshold row: its question card now, its delivery once the provisional summary settles. */
  const releaseWaiting = Effect.fnUntraced(function* (
    row: SquireRepository.SquireEventRow,
    now: DateTime.Utc,
  ) {
    const payload = Option.getOrNull(decodePayload(row.payload_json));
    const request = payload?.pendingRequest;
    const threadId = row.thread_id;
    if (!payload || !request || threadId === null) {
      return yield* promote([row.id]);
    }
    const question = yield* readSquireQuestion(projections, threadId, {
      requestId: request.requestId,
      secretTurnItemId: request.kind === "secret" ? TurnItemId.make(request.requestId) : undefined,
    });
    if (Option.isNone(question) || !question.value.pending) {
      yield* repository.setEventStatus({
        ids: [row.id],
        fromStatuses: ["deferred"],
        status: "dropped",
      });
      return [];
    }
    const shell = yield* projections.getThreadShell(threadId);
    const key =
      payload.runId === null
        ? null
        : ({ threadId, runId: payload.runId, stage: `request:${request.requestId}` } as const);
    const result = yield* repository.transaction(
      Effect.gen(function* () {
        const moved = yield* repository.setEventStatus({
          ids: [row.id],
          fromStatuses: ["deferred"],
          ...(key === null
            ? { status: "pending" as const }
            : {
                status: "deferred" as const,
                deferReason: "summary" as const,
                notBefore: DateTime.formatIso(
                  DateTime.add(now, { milliseconds: SQUIRE_SUMMARY_WAIT_MS }),
                ),
              }),
        });
        if (moved.length === 0) return { moved: false, lead: Option.none<SquireId>() };
        const lead = yield* raiseQuestionCard(
          row,
          payload,
          squireQuestionTitle(question.value.question),
          shell?.projectId ?? null,
        );
        return { moved: true, lead };
      }),
    );
    if (Option.isSome(result.lead)) yield* delivery.wake(result.lead.value);
    if (!result.moved) return [];
    if (key === null) {
      yield* delivery.wake(row.squire_id);
      return [row.squire_id];
    }
    const squire = yield* repository.getSquire(row.squire_id);
    yield* ensureThenPromote(
      key,
      Option.toArray(squire),
      [row.id],
      refreshQuestionWhy(row, request),
    );
    return [];
  });

  const promoteDue: SquireReactor["Service"]["promoteDue"] = Effect.fn("SquireReactor.promoteDue")(
    function* (now) {
      const dueBy = DateTime.formatIso(now);
      const gained: Array<SquireId> = [];
      const waiting = yield* repository.listEvents({
        statuses: ["deferred"],
        deferReasons: ["threshold"],
        dueBy,
      });
      for (const row of waiting) gained.push(...(yield* releaseWaiting(row, now)));
      const late = yield* repository.listEvents({
        statuses: ["deferred"],
        deferReasons: ["summary"],
        dueBy,
      });
      gained.push(...(yield* promote(late.map((row) => row.id))));
      return [...new Set(gained)];
    },
  );

  // ── Card outdating ──

  const openCardsFor = (threadId: ThreadId) =>
    repository.listCards({ targetThreadId: threadId, statuses: ["open", "held"] });

  const wakeLead = (lead: Option.Option<SquireId>) =>
    Option.isSome(lead) ? delivery.wake(lead.value) : Effect.void;

  /**
   * A hold the reactor takes down was an action under way, so it logs the
   * cancellation as an execution-time refusal does (`SquireActions.outdate`).
   */
  const logHoldCancelled = (card: SquireRepository.SquireCardRow, reason: string, now: string) =>
    card.status !== "held"
      ? Effect.void
      : repository
          .insertActionLog({
            squire_id: card.squire_id,
            kind: "action.cancelled",
            room_id: null,
            post_id: null,
            trigger_id: null,
            task_id: null,
            thread_id: card.target_thread_id,
            card_id: card.id,
            event_id: null,
            run_id: null,
            invocation_key: null,
            execution_key: null,
            data_json: encodeJson({ reason, to: "outdated" }),
            created_at: now,
          })
          .pipe(Effect.asVoid);

  /** Each card that moves gets its Lead item-resolved row in the same transaction. */
  const moveCards = (
    cards: ReadonlyArray<SquireRepository.SquireCardRow>,
    patchOf: (card: SquireRepository.SquireCardRow) => SquireRepository.SquireCardPatch,
    now: string,
    reason: string,
  ) =>
    repository
      .transaction(
        Effect.gen(function* () {
          const moved: Array<SquireRepository.SquireCardRow> = [];
          for (const card of cards) {
            const updated = yield* repository.updateCard({
              id: card.id,
              fromStatuses: ["open", "held"],
              patch: patchOf(card),
              updatedAt: now,
            });
            if (Option.isNone(updated)) continue;
            moved.push(updated.value);
            if (updated.value.status === "outdated") yield* logHoldCancelled(card, reason, now);
          }
          return yield* writeLeadItemsResolved(repository, moved, now);
        }),
      )
      .pipe(Effect.flatMap(wakeLead));

  const outdate = (
    cards: ReadonlyArray<SquireRepository.SquireCardRow>,
    now: string,
    reason: string,
  ) =>
    moveCards(
      cards,
      () => ({ status: "outdated", resolution: "outdated", executes_at: null }),
      now,
      reason,
    );

  /** Run inside a transaction; wake the returned Lead after it commits. */
  const outdateThreadCards = Effect.fnUntraced(function* (
    threadId: ThreadId,
    now: string,
    reason: string,
  ) {
    const cards = yield* openCardsFor(threadId);
    const outdated = new Set(
      yield* repository.outdateCardsForThread({
        threadId,
        resolution: "outdated",
        updatedAt: now,
      }),
    );
    const moved = cards.filter((card) => outdated.has(card.id));
    for (const card of moved) yield* logHoldCancelled(card, reason, now);
    return yield* writeLeadItemsResolved(
      repository,
      moved.map((card) => ({ ...card, status: "outdated" as const, resolution: "outdated" })),
      now,
    );
  });

  const triggerOf = (card: SquireRepository.SquireCardRow) =>
    Option.getOrElse(decodeTrigger(card.trigger_json), () => ({}) as SquireCardTrigger);

  const onRunStarted = Effect.fnUntraced(function* (threadId: ThreadId, runId: RunId) {
    // A newer run drops turn-finished rows still held by background work.
    const held = yield* repository.listEvents({
      statuses: ["deferred"],
      deferReasons: ["background"],
      threadId,
      kinds: ["turn-finished"],
    });
    yield* repository.setEventStatus({
      ids: held.filter((row) => row.state_key !== runId).map((row) => row.id),
      fromStatuses: ["deferred"],
      status: "dropped",
    });
    const cards = yield* openCardsFor(threadId);
    if (cards.length === 0) return;
    const now = yield* nowIso;
    const message = yield* projections.getRunMessage(threadId, runId);
    // A user turn outdates every open card and cancels every hold on the thread.
    if (message?.createdBy === "user") {
      yield* wakeLead(
        yield* repository.transaction(
          outdateThreadCards(threadId, now, "the user wrote in the thread"),
        ),
      );
      return;
    }
    // Any new turn makes a card raised for an earlier run obsolete.
    yield* outdate(
      cards.filter((card) => {
        const trigger = triggerOf(card);
        return trigger.runId !== undefined && trigger.runId !== runId;
      }),
      now,
      "a newer turn started in the thread",
    );
  });

  /** A new state for the same PR obsoletes cards raised for one it no longer holds. */
  const onPullRequestLink = Effect.fnUntraced(function* (
    threadId: ThreadId,
    link: ThreadPullRequestLink,
  ) {
    const snapshot = link.snapshot;
    const revision = snapshot === null ? undefined : squirePullRequestRevision(snapshot);
    if (snapshot === null || revision === undefined) return;
    const cards = yield* openCardsFor(threadId);
    if (cards.length === 0) return;
    const prKey = threadPullRequestKeyOf(link);
    const current = new Set(
      squirePullRequestStates(snapshot).map((state) => `${revision}:${state}`),
    );
    yield* outdate(
      cards.filter((card) => {
        const trigger = triggerOf(card);
        return trigger.prKey === prKey && !current.has(`${trigger.headSha}:${trigger.transition}`);
      }),
      yield* nowIso,
      "the pull request changed",
    );
  });

  const onRequestResolved = Effect.fnUntraced(function* (
    threadId: ThreadId,
    requestId: string,
    settled: SquireRepository.SquireCardPatch,
  ) {
    // A row already pending is dropped too: only a batched one is past recall.
    const waiting = yield* repository.listEvents({
      statuses: ["deferred", "pending"],
      threadId,
      kinds: ["waiting-on-user"],
    });
    yield* repository.setEventStatus({
      ids: waiting.filter((row) => row.state_key === requestId).map((row) => row.id),
      fromStatuses: ["deferred", "pending"],
      status: "dropped",
    });
    const cards = (yield* openCardsFor(threadId)).filter(
      (card) => triggerOf(card).requestId === requestId,
    );
    yield* moveCards(
      cards,
      (card) =>
        card.kind === "question"
          ? settled
          : { status: "outdated", resolution: "outdated", executes_at: null },
      yield* nowIso,
      "the request was answered",
    );
  });

  const onBackgroundWorkEnded = Effect.fnUntraced(function* (threadId: ThreadId) {
    const held = yield* repository.listEvents({
      statuses: ["deferred"],
      deferReasons: ["background"],
      threadId,
    });
    if (held.length === 0) return;
    const shell = yield* projections.getThreadShell(threadId);
    if (shell !== null && backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? [])) {
      return;
    }
    for (const row of held) {
      const runId = Option.getOrNull(decodePayload(row.payload_json))?.runId ?? null;
      const summary =
        runId === null
          ? Option.none()
          : yield* summaries.read({ threadId, runId, stage: "terminal" });
      if (runId === null || (Option.isSome(summary) && summary.value.status !== "generating")) {
        yield* promote([row.id]);
        continue;
      }
      const moved = yield* repository.setEventStatus({
        ids: [row.id],
        fromStatuses: ["deferred"],
        status: "deferred",
        deferReason: "summary",
      });
      if (moved.length === 0) continue;
      const squire = yield* repository.getSquire(row.squire_id);
      yield* ensureThenPromote({ threadId, runId, stage: "terminal" }, Option.toArray(squire), [
        row.id,
      ]);
    }
  });

  // ── Cascades ──

  const disableRules = (squireIds: Iterable<SquireId>) =>
    Option.isNone(rules)
      ? Effect.void
      : Effect.forEach(new Set(squireIds), (id) => rules.value.disableOutOfScope(id), {
          discard: true,
        });

  /**
   * Re-homes to the most recently active project, serialized so a home lost
   * twice (project then thread) re-homes once.
   */
  const rehome = (squireId: SquireId, stillLost: (row: SquireRepository.SquireRow) => boolean) =>
    Option.isNone(lifecycle)
      ? Effect.logWarning("Squire home lost with no lifecycle to re-home it", { squireId })
      : fork(
          "Squire re-home failed",
          rehoming.withPermits(1)(
            Effect.gen(function* () {
              const row = yield* repository.getSquire(squireId);
              if (Option.isNone(row) || row.value.lifecycle === "deleting") return;
              if (!stillLost(row.value)) return;
              yield* lifecycle.value.rehome(squireId);
            }),
          ),
        );

  /**
   * A settled or archived thread leaves every Squire's scope (SquireScope), so
   * what was queued about it goes too: its waiting events are dropped and its
   * open cards and holds outdated, so nothing is delivered or fires against
   * finished work. Unsettling brings the thread back for what happens next.
   */
  const onThreadLeftScope = Effect.fnUntraced(function* (threadId: ThreadId, reason: string) {
    const lead = yield* withPolicyLock(
      repository.transaction(
        Effect.gen(function* () {
          const waiting = yield* repository.listEvents({
            statuses: ["pending", "deferred"],
            threadId,
          });
          yield* repository.setEventStatus({
            ids: waiting.map((row) => row.id),
            fromStatuses: ["pending", "deferred"],
            status: "dropped",
          });
          return yield* outdateThreadCards(threadId, yield* nowIso, reason);
        }),
      ),
    );
    yield* wakeLead(lead);
  });

  const onThreadDeleted = Effect.fnUntraced(function* (
    effect: Extract<SquireReactorEffect, { readonly type: "thread-deleted" }>,
  ) {
    const { threadId, squire } = effect;
    if (squire !== null) {
      if (squire.role === "home") {
        yield* rehome(squire.squireId, (row) => row.home_thread_id === threadId);
      }
      return;
    }
    const { affected, lead } = yield* withPolicyLock(
      repository.transaction(
        Effect.gen(function* () {
          const grants = [
            ...(yield* repository.listGrantsForTarget({ kind: "thread", targetId: threadId })),
            ...(yield* repository.listGrantsForTarget({ kind: "exclusion", targetId: threadId })),
          ];
          yield* repository.deleteGrantsForTarget({ kind: "thread", targetId: threadId });
          yield* repository.deleteGrantsForTarget({ kind: "exclusion", targetId: threadId });
          yield* repository.deleteThreadEvents(threadId);
          yield* repository.deleteThreadSummaries(threadId);
          const lead = yield* outdateThreadCards(
            threadId,
            yield* nowIso,
            "the thread no longer exists",
          );
          return { affected: grants.map((grant) => grant.squire_id), lead };
        }),
      ),
    );
    yield* wakeLead(lead);
    yield* disableRules(affected);
  });

  const onProjectDeleted = Effect.fnUntraced(function* (projectId: ProjectId) {
    const { affected, lead } = yield* withPolicyLock(
      repository.transaction(
        Effect.gen(function* () {
          const grants = yield* repository.listGrantsForTarget({
            kind: "project",
            targetId: projectId,
          });
          yield* repository.deleteGrantsForTarget({ kind: "project", targetId: projectId });
          const now = yield* nowIso;
          let lead = Option.none<SquireId>();
          for (const grant of grants) {
            const woken = yield* retireOutOfScope(repository, scope, {
              squireId: grant.squire_id,
              now,
            });
            if (Option.isSome(woken)) lead = woken;
          }
          return { affected: grants.map((grant) => grant.squire_id), lead };
        }),
      ),
    );
    yield* wakeLead(lead);
    yield* disableRules(affected);
    for (const row of yield* repository.listSquires) {
      if (row.home_project_id === projectId) {
        yield* rehome(row.id, (current) => current.home_project_id === projectId);
      }
    }
  });

  /** A home build that stopped for want of a project goes on once there is one. */
  const onProjectCreated = Effect.gen(function* () {
    if (Option.isNone(lifecycle)) return;
    for (const row of yield* repository.listSquires) {
      if (row.lifecycle !== "rehoming" && row.lifecycle !== "creating") continue;
      yield* fork("Squire re-home failed", rehoming.withPermits(1)(lifecycle.value.drive(row.id)));
    }
  });

  const threadGone = (threadId: ThreadId) =>
    projections
      .getThreadShell(threadId)
      .pipe(Effect.map((shell) => shell === null || shell.deletedAt !== null));
  const projectGone = (projectId: ProjectId) =>
    projects.get(projectId).pipe(Effect.map(Option.isNone));

  /**
   * Turning the switch on skips the off period's events, its deletes too, so
   * their cascades run here from current state: grants, cards, and queued
   * events whose thread or project is gone, and homes that are gone.
   */
  const reconcileOffPeriod = Effect.gen(function* () {
    const squires = (yield* repository.listSquires).filter((row) => row.lifecycle !== "deleting");
    const goneProjects = new Set<ProjectId>();
    const goneThreads = new Set<ThreadId>();
    const checkThread = Effect.fnUntraced(function* (threadId: ThreadId) {
      if (!goneThreads.has(threadId) && (yield* threadGone(threadId))) goneThreads.add(threadId);
    });
    for (const row of squires) {
      for (const grant of yield* repository.listGrants(row.id)) {
        if (grant.kind === "thread" || grant.kind === "exclusion") {
          yield* checkThread(ThreadId.make(grant.target_id));
        } else if (grant.kind === "project") {
          const projectId = ProjectId.make(grant.target_id);
          if (yield* projectGone(projectId)) goneProjects.add(projectId);
        }
      }
    }
    for (const card of yield* repository.listCards({ statuses: ["open", "held"] })) {
      if (card.target_thread_id !== null) yield* checkThread(card.target_thread_id);
    }
    for (const row of yield* repository.listEvents({ statuses: ["deferred", "pending"] })) {
      if (row.thread_id !== null) yield* checkThread(row.thread_id);
    }
    for (const projectId of goneProjects) yield* onProjectDeleted(projectId);
    for (const threadId of goneThreads) {
      yield* onThreadDeleted({ type: "thread-deleted", threadId, squire: null });
    }
    for (const row of squires) {
      const projectId = row.home_project_id;
      // A gone grant project re-homed its Squires above.
      if (goneProjects.has(projectId)) continue;
      if (yield* projectGone(projectId)) {
        yield* rehome(row.id, (current) => current.home_project_id === projectId);
        continue;
      }
      const threadId = row.home_thread_id;
      if (row.lifecycle === "ready" && threadId !== null && (yield* threadGone(threadId))) {
        yield* rehome(row.id, (current) => current.home_thread_id === threadId);
      }
    }
  });

  // ── Squire threads ──

  const autoDecline = Effect.fnUntraced(
    function* (effect: Extract<SquireReactorEffect, { readonly type: "auto-decline" }>) {
      const request = yield* projections.getRuntimeRequest(effect.threadId, effect.requestId);
      // Later updates of a request already declined change nothing.
      if (request?.status !== "pending") return;
      yield* withSquireDispatchOrigin(
        orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(
            `server:squire:auto-decline:${effect.threadId}:${effect.requestId}`,
          ),
          threadId: effect.threadId,
          requestId: effect.requestId,
          decision: "decline",
        }),
      );
      yield* repository.insertActionLog({
        squire_id: effect.squire.squireId,
        kind: "decision.recorded",
        room_id: null,
        post_id: null,
        trigger_id: null,
        task_id: null,
        thread_id: effect.threadId,
        card_id: null,
        event_id: null,
        run_id: null,
        invocation_key: null,
        execution_key: null,
        data_json: encodeJson({
          decision: "decline",
          reason: "deny-runtime",
          requestId: effect.requestId,
          requestKind: effect.requestKind,
          role: effect.squire.role,
        }),
        created_at: yield* nowIso,
      });
    },
    (self, effect) =>
      self.pipe(logged("Squire auto-decline failed", { requestId: effect.requestId })),
  );

  /**
   * A user who talks to the Lead before its first-run scan has met it their
   * own way: the scan stays off until a client asks for it with `start`, so
   * an older client's plain open never queues it later.
   */
  const noteLeadChat = Effect.fnUntraced(function* (
    squireId: SquireId,
    threadId: ThreadId,
    runId: RunId,
  ) {
    const squire = yield* repository.getSquire(squireId);
    if (Option.isNone(squire) || squire.value.role !== "lead") return;
    if (squire.value.onboarded_at !== null) return;
    const message = yield* projections.getRunMessage(threadId, runId);
    if (message?.createdBy !== "user") return;
    const now = yield* nowIso;
    yield* repository.updateSquire({
      id: squireId,
      patch: { onboarded_at: now },
      updatedAt: now,
    });
  });

  const apply = (effect: SquireReactorEffect, stored: ApplicationStoredEvent) => {
    switch (effect.type) {
      case "request-resolved":
        return onRequestResolved(effect.threadId, effect.requestId, questionSettledBy(stored));
      case "run-started":
        return onRunStarted(effect.threadId, effect.runId);
      case "background-work-ended":
        return onBackgroundWorkEnded(effect.threadId);
      case "thread-deleted":
        return onThreadDeleted(effect);
      case "project-deleted":
        return onProjectDeleted(effect.projectId);
      case "auto-decline":
        return autoDecline(effect);
      case "squire-run-ended":
        return effect.squire.role === "home"
          ? fork(
              "Squire run finalize failed",
              noteLeadChat(effect.squire.squireId, effect.threadId, effect.runId).pipe(
                Effect.andThen(
                  delivery.finalizeRun({
                    squireId: effect.squire.squireId,
                    homeThreadId: effect.threadId,
                    runId: effect.runId,
                    status: effect.status,
                  }),
                ),
              ),
            )
          : Option.isSome(probe)
            ? fork(
                "Squire probe answer failed",
                probe.value.finish({
                  squireId: effect.squire.squireId,
                  threadId: effect.threadId,
                  runId: effect.runId,
                  status: effect.status,
                }),
              )
            : Effect.void;
      case "thread-created":
        // Scope reads shells fresh, so a new thread in a granted container needs nothing.
        return Effect.void;
    }
  };

  /** True when the event did work worth a cursor write. */
  const handle = Effect.fn("SquireReactor.handle")(function* (stored: ApplicationStoredEvent) {
    const needs = squireClassifyNeeds(stored);
    const event = "event" in stored ? stored.event : null;
    const shell =
      event !== null && (needs.threadMarker || needs.pendingBackgroundTasks)
        ? yield* projections.getThreadShell(event.threadId)
        : null;
    const interruptedBy =
      event?.type === "run.updated" && needs.interruptedBy
        ? squireInterruptActor(
            (yield* projections.getThreadRecords(event.threadId, ["turnItems"], {
              turnItemRunId: event.payload.id,
              turnItemTypes: ["run_interrupt_request"],
            })).turnItems,
            event.payload.id,
          )
        : null;
    const { candidates, effects } = classifySquireEvent(stored, {
      threadMarker: shell?.squire ?? null,
      interruptedBy,
      pendingBackgroundTasks: shell?.pendingBackgroundTasks ?? [],
    });
    if (candidates.length > 0) yield* ingest(candidates, shell);
    for (const effect of effects) yield* apply(effect, stored);
    if (!("event" in stored) && stored.type === "project.created") yield* onProjectCreated;
    if (event?.type === "thread.pull-request-link-updated" && shell?.squire === undefined) {
      yield* onPullRequestLink(event.threadId, event.payload);
    }
    if (event !== null && Option.isSome(hooks) && THREAD_CHANGE_EVENTS.has(event.type)) {
      yield* hooks.value.threadChanged(event.threadId);
    }
    const leftScope =
      event?.type === "thread.settled"
        ? "the thread was settled"
        : event?.type === "thread.archived"
          ? "the thread was archived"
          : undefined;
    if (event !== null && leftScope !== undefined) {
      yield* onThreadLeftScope(event.threadId, leftScope);
      return true;
    }
    return candidates.length > 0 || effects.length > 0;
  });

  const start: SquireReactor["Service"]["start"] = ({ turnedOn }) => {
    // Once per on period, not per restart of the loop below.
    let offPeriodPending = turnedOn;
    return Effect.gen(function* () {
      if (offPeriodPending) {
        yield* reconcileOffPeriod.pipe(logged("Squire off-period reconcile failed"));
        offPeriodPending = false;
      }
      const cursor = yield* repository.readCursor;
      yield* SubscriptionRef.set(seen, cursor.sequence);
      let ignored = 0;
      yield* Stream.runForEach(
        events.streamApplicationEvents({ afterSequence: cursor.sequence }),
        (stored) =>
          Effect.gen(function* () {
            const worked = yield* handle(stored).pipe(
              Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 3 }),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logError("Squire reactor skipped an event it could not process", {
                      sequence: stored.sequence,
                      cause: Cause.pretty(cause),
                    }).pipe(Effect.as(true)),
              ),
            );
            ignored = worked ? 0 : ignored + 1;
            if (worked || ignored >= IGNORED_CURSOR_WRITE_INTERVAL) {
              ignored = 0;
              yield* repository.writeCursor({ sequence: stored.sequence, enabled: cursor.enabled });
            }
            yield* SubscriptionRef.set(seen, stored.sequence);
          }),
      );
      return yield* Effect.die("the application event stream ended");
    }).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("Squire reactor stopped; restarting from its cursor", {
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.orDie,
      // The forked work belongs to the on period: turning Squires off stops a
      // paid summary call mid-flight, and its `generating` row settles to
      // `partial` before the next period's reactor can start the same summary.
      Effect.ensuring(FiberSet.clear(fibers)),
    );
  };

  const drainThrough: SquireReactor["Service"]["drainThrough"] = (sequence) =>
    SubscriptionRef.changes(seen).pipe(
      Stream.filter((at) => at >= sequence),
      Stream.runHead,
      Effect.andThen(settled),
    );

  return SquireReactor.of({ start, drainThrough, promoteDue });
});

/**
 * How a question card settles with its request: answered (however it
 * was answered) or a declined secret resolves it; expiry and cancellation
 * outdate it. Only the status crosses over, never a secret's value.
 */
const questionSettledBy = (stored: ApplicationStoredEvent): SquireRepository.SquireCardPatch => {
  const outdated = (resolution: string) =>
    ({ status: "outdated", resolution, executes_at: null }) as const;
  if (!("event" in stored)) return outdated("outdated");
  const { event } = stored;
  if (event.type === "runtime-request.updated") {
    switch (event.payload.status) {
      case "resolved":
        return { status: "resolved", resolution: "answered" };
      case "expired":
      case "cancelled":
        return outdated(event.payload.status);
    }
  }
  if (event.type === "turn-item.updated" && event.payload.type === "secret_request") {
    switch (event.payload.secretStatus) {
      case "saved":
        return { status: "resolved", resolution: "answered" };
      case "declined":
        return { status: "resolved", resolution: "declined" };
      case "cancelled":
        return outdated("cancelled");
    }
  }
  return outdated("outdated");
};

export const layer = Layer.effect(SquireReactor, make);
