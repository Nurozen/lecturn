/**
 * The server, not the model, picks sweep candidates; an empty sweep logs one `sweep.ran` row and runs no Lead turn,
 * so it costs no tokens. Findings are admitted against the sweep budget and the dismissal memory (`finding_key`).
 */
import {
  isUnknownUnionMember,
  type OrchestrationV2ThreadShell,
  SquireCardTrigger,
  SquireDigest,
  SquireError,
  SquireEvent,
  type SquireId,
  type SquireLeadSweepInput,
  type SquireLeadSweepResult,
  type SquireSweepCandidate,
  SquireSweepSettings,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@lecturn/contracts";
import { threadPullRequestKeyOf } from "../sourceControl/threadPullRequests.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import { squireStateKey } from "./squireEvents.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireSwitch from "./SquireSwitch.ts";
import * as SquireScope from "./SquireScope.ts";
import { isSquireThread } from "./squireThread.ts";

const SQUIRE_SWEEP_MAX_CANDIDATES = 10;
/** The daily sweep runs at the digest time; with no digest set, at this local time. */
const SQUIRE_DEFAULT_SWEEP_TIME = "09:00";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const IDLE_MS = DAY_MS;
const ACCEPTANCE_WINDOW_MS = 30 * DAY_MS;
/** Outcomes are backfilled for findings finalized this recently. */
const OUTCOME_LOOKBACK_MS = 31 * DAY_MS;

const RAN = "sweep.ran";
const FINDING = "sweep.finding";

const OPEN_STATUSES = ["held", "open", "accepting", "executing"] as const;
const FINAL_STATUSES = ["resolved", "executed", "dismissed", "outdated"] as const;
const EVENT_STATUSES = ["deferred", "pending", "batched", "delivered", "dropped"] as const;

export type SquireSweepRefusal =
  | "paused"
  | "not-a-sweep"
  | "not-a-candidate"
  | "finding-dismissed"
  | "already-raised"
  | "sweep-findings-reached"
  | "daily-findings-reached";

export interface SquireSweepFindingInput {
  readonly lead: SquireRepository.SquireRow;
  /** The run's delivered batch (`SquireToolKit.batchEvents`). */
  readonly batchEvents: ReadonlyArray<SquireRepository.SquireEventRow>;
  /** The sweep candidate the finding is about. */
  readonly threadId: ThreadId | null;
  readonly kind: "steer" | "proposal";
  readonly now: string;
}

/** On `ok` the card carries `findingKey`, origin `sweep`, and `trigger` (its `requestId` is the sweep key). */
export type SquireSweepAdmission =
  | { readonly ok: true; readonly findingKey: string; readonly trigger: SquireCardTrigger }
  | { readonly ok: false; readonly reason: SquireSweepRefusal; readonly text: string };

interface SquireSweepAcceptance {
  readonly accepted: number;
  readonly total: number;
}

type SweepResult = typeof SquireLeadSweepResult.Type;
type SweepSource = "schedule" | "request";

export class SquireSweep extends Context.Service<
  SquireSweep,
  {
    /** Runs the latest scheduled slot at or before `now` once, if the Lead may sweep. */
    readonly due: (now: DateTime.Utc) => Effect.Effect<void, SquireError>;
    /** The next moment `due` has work, for SquireClock to arm on. */
    readonly nextDueAt: (
      now: DateTime.Utc,
    ) => Effect.Effect<Option.Option<DateTime.Utc>, SquireError>;
    /** Find work: one sweep keyed by the request id, idempotent on it. */
    readonly request: (
      input: typeof SquireLeadSweepInput.Type,
    ) => Effect.Effect<SweepResult, SquireError>;
    /** Inside the caller's transaction, so the budget counts stay exact. */
    readonly admitFinding: (
      input: SquireSweepFindingInput,
    ) => Effect.Effect<SquireSweepAdmission, SquireError | PersistenceSqlError>;
    /** Writes the `sweep.finding` row of every finding that reached a final state; returns how many. */
    readonly recordOutcomes: (now: DateTime.Utc) => Effect.Effect<number, SquireError>;
    /** Over the `sweep.finding` rows of the last 30 days, after recording due outcomes. */
    readonly acceptanceRate: (
      leadId: SquireId,
      now: DateTime.Utc,
    ) => Effect.Effect<SquireSweepAcceptance, SquireError>;
  }
>()("lecturn/squire/SquireSweep") {}

// ── Local time, shared with the digest ──

/** The Lead's zone; server local until a client reports one. */
export const leadZoneOf = (lead: Pick<SquireRepository.SquireRow, "timezone">) =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(lead.timezone), DateTime.zoneMakeNamed),
    DateTime.zoneMakeLocal,
  );

export const localDateOf = (at: DateTime.Utc, zone: DateTime.TimeZone) =>
  DateTime.formatIsoDate(DateTime.setZone(at, zone));

/** The slot at local `time` on the local date of `at`, through the pure scheduler. */
export const dailySlotOn = (time: string, zone: DateTime.TimeZone, at: DateTime.Utc) => {
  const dayStart = DateTime.startOf(DateTime.setZone(at, zone), "day");
  const slot = nextScheduledRunAt(
    { type: "fixed_time", timeOfDay: time },
    DateTime.subtract(dayStart, { milliseconds: 1 }),
  );
  return slot === null ? Option.none() : Option.some(DateTime.toUtc(slot));
};

/** The first slot after `at` at local `time`. */
export const nextDailySlot = (time: string, zone: DateTime.TimeZone, at: DateTime.Utc) => {
  const slot = nextScheduledRunAt(
    { type: "fixed_time", timeOfDay: time },
    DateTime.setZone(at, zone),
  );
  return slot === null ? Option.none() : Option.some(DateTime.toUtc(slot));
};

const decodeDigest = Schema.decodeUnknownOption(Schema.fromJsonString(SquireDigest));
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(SquireSweepSettings));
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(SquireEvent));
const decodeTrigger = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCardTrigger));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const RanData = Schema.Struct({
  sweepKey: Schema.String,
  source: Schema.String,
  outcome: Schema.Literals(["queued", "empty", "budget-reached"]),
  candidates: Schema.Number,
  retryAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeRan = Schema.decodeUnknownOption(Schema.fromJsonString(RanData));
const encodeRan = Schema.encodeSync(Schema.fromJsonString(RanData));
const FindingData = Schema.Struct({
  outcome: Schema.Literals(["accepted", "dismissed", "outdated"]),
  findingKey: Schema.String,
});
const decodeFinding = Schema.decodeUnknownOption(Schema.fromJsonString(FindingData));
const encodeFinding = Schema.encodeSync(Schema.fromJsonString(FindingData));

const DEFAULT_SWEEP_SETTINGS = Schema.decodeSync(SquireSweepSettings)({});

const settingsOf = (lead: Pick<SquireRepository.SquireRow, "sweep_json">) =>
  Option.getOrElse(decodeSettings(lead.sweep_json ?? "{}"), () => DEFAULT_SWEEP_SETTINGS);

/** Dismissal memory per (thread, candidate kind, PR head). */
const findingKeyOf = (candidate: SquireSweepCandidate) =>
  `${candidate.threadId}:${candidate.kind}:${candidate.headSha ?? "none"}`;

const isoPlus = (iso: string, ms: number) =>
  DateTime.formatIso(DateTime.addDuration(DateTime.makeUnsafe(iso), ms));
const minusMs = (at: DateTime.Utc, ms: number) =>
  DateTime.formatIso(DateTime.subtract(at, { milliseconds: ms }));
const ms = (at: DateTime.Utc | null | undefined) =>
  at === null || at === undefined ? null : DateTime.toEpochMillis(at);

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scope = yield* SquireScope.SquireScope;
  const delivery = yield* Effect.serviceOption(SquireDelivery.SquireDelivery);
  const enabled = (yield* SquireSwitch.SquireSwitch).isOn;
  // Orders the dedupe-and-count of a sweep with its insert.
  const runLock = (yield* Semaphore.make(1)).withPermits(1);

  /** The sweep stops while the Lead is paused or under the inactivity pause. */
  const sweeping = (lead: SquireRepository.SquireRow) =>
    lead.status === "active" &&
    lead.automation_paused_at === null &&
    lead.lifecycle === "ready" &&
    lead.home_thread_id !== null;

  const sweepTime = (lead: SquireRepository.SquireRow) =>
    Option.match(decodeDigest(lead.digest_json ?? ""), {
      onNone: () => SQUIRE_DEFAULT_SWEEP_TIME,
      onSome: (digest) => digest.time,
    });

  /** The latest scheduled slot at or before `now`, and the one after it. */
  const slotsAround = (lead: SquireRepository.SquireRow, now: DateTime.Utc) => {
    const schedule = settingsOf(lead).schedule;
    const zone = leadZoneOf(lead);
    if (schedule.kind === "off") return { latest: Option.none(), next: Option.none() };
    if (schedule.kind === "daily") {
      const time = sweepTime(lead);
      const today = dailySlotOn(time, zone, now);
      // Only today's slot catches up; a slot missed on an earlier day is gone.
      const latest = Option.filter(today, (slot) => DateTime.isLessThanOrEqualTo(slot, now));
      return { latest, next: nextDailySlot(time, zone, now) };
    }
    // Every N hours from local midnight, restarting each local day.
    const period = schedule.hours * HOUR_MS;
    const dayStart = DateTime.toUtc(DateTime.startOf(DateTime.setZone(now, zone), "day"));
    const nextDay = DateTime.toUtc(
      DateTime.startOf(DateTime.add(DateTime.setZone(now, zone), { days: 1 }), "day"),
    );
    const k = Math.floor((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dayStart)) / period);
    const latest = DateTime.addDuration(dayStart, k * period);
    const following = DateTime.addDuration(dayStart, (k + 1) * period);
    return {
      latest: Option.some(latest),
      next: Option.some(DateTime.min(following, nextDay)),
    };
  };

  const ranRows = (leadId: SquireId, now: DateTime.Utc, windowMs: number) =>
    repository
      .listActionLogAfter({ squireId: leadId, kinds: [RAN], after: minusMs(now, windowMs) })
      .pipe(
        Effect.map((rows) =>
          rows.flatMap((row) =>
            Option.match(decodeRan(row.data_json), {
              onNone: () => [],
              onSome: (data) => [{ row, data }],
            }),
          ),
        ),
      );

  /** A slot belongs to the Lead from its creation on, so a new Lead does not sweep at once. */
  const dueSlot = Effect.fn("SquireSweep.dueSlot")(function* (
    lead: SquireRepository.SquireRow,
    now: DateTime.Utc,
  ) {
    if (!(yield* enabled) || !sweeping(lead)) return Option.none<DateTime.Utc>();
    const { latest } = slotsAround(lead, now);
    if (Option.isNone(latest) || DateTime.formatIso(latest.value) < lead.created_at) {
      return Option.none<DateTime.Utc>();
    }
    const key = scheduleKey(latest.value);
    const ran = yield* ranRows(lead.id, now, 2 * DAY_MS);
    return ran.some((entry) => entry.data.sweepKey === key) ? Option.none() : latest;
  });

  const scheduleKey = (slot: DateTime.Utc) => `schedule:${DateTime.formatIso(slot)}`;

  const hasOpenDecision = (threadId: ThreadId) =>
    repository
      .listCards({ targetThreadId: threadId, statuses: [...OPEN_STATUSES] })
      .pipe(Effect.map((cards) => cards.some((card) => card.kind !== "fyi")));

  /** When the checks first failed on this head, from the trackers' PR event rows. */
  const failureAt = Effect.fn("SquireSweep.failureAt")(function* (
    threadId: ThreadId,
    link: ThreadPullRequestLink,
    headSha: string,
  ) {
    const key = squireStateKey({
      kind: "pull-request-changed",
      pullRequest: link,
      headSha,
      state: "checks:failed",
    });
    const rows = yield* repository.listEvents({
      statuses: [...EVENT_STATUSES],
      threadId,
      kinds: ["pull-request-changed"],
    });
    const first = rows
      .filter((row) => row.state_key === key)
      .map((row) => Date.parse(row.created_at))
      .toSorted((a, b) => a - b)[0];
    if (first !== undefined) return first;
    // No tracker heard the transition: the snapshot's own time is the best bound.
    const snapshot = link.snapshot;
    return Date.parse(snapshot?.updatedAt ?? snapshot?.syncedAt ?? "") || 0;
  });

  // Runs per thread in a sweep; SquireSweep.candidates owns the span.
  const candidateFor = Effect.fnUntraced(function* (
    shell: OrchestrationV2ThreadShell,
    nowMs: number,
    dismissed: ReadonlySet<string>,
  ) {
    if (shell.activeRunId !== null) return Option.none<SquireSweepCandidate & { at: number }>();
    const lastStart = ms(shell.latestRunStartedAt) ?? ms(shell.latestRunRequestedAt);
    const lastTurn = Math.max(
      ms(shell.latestRunCompletedAt) ?? 0,
      lastStart ?? 0,
      lastStart === null ? DateTime.toEpochMillis(shell.createdAt) : 0,
    );
    const open = (shell.pullRequests ?? []).filter((link) => link.snapshot?.state === "open");
    for (const link of open) {
      const headSha = link.snapshot?.headSha;
      if (link.snapshot?.checksState !== "failing" || headSha === undefined) continue;
      const candidate: SquireSweepCandidate = {
        threadId: shell.id,
        kind: "failing-checks-no-turn",
        pullRequestNumber: link.number,
        headSha,
      };
      if (dismissed.has(findingKeyOf(candidate))) continue;
      const failedAt = yield* failureAt(shell.id, link, headSha);
      if (lastStart === null || lastStart < failedAt) {
        return Option.some({ ...candidate, at: lastTurn });
      }
    }
    const link = open[0];
    if (link !== undefined && nowMs - lastTurn >= IDLE_MS) {
      const candidate: SquireSweepCandidate = {
        threadId: shell.id,
        kind: "idle-unmerged-pr",
        pullRequestNumber: link.number,
        headSha: link.snapshot?.headSha ?? null,
      };
      if (!dismissed.has(findingKeyOf(candidate)))
        return Option.some({ ...candidate, at: lastTurn });
    }
    return Option.none<SquireSweepCandidate & { at: number }>();
  });

  /** Tracked threads of active Squires, failing heads first, then the longest idle. */
  const candidates = Effect.fn("SquireSweep.candidates")(function* (
    lead: SquireRepository.SquireRow,
    now: DateTime.Utc,
  ) {
    const active = new Set(
      (yield* repository.listSquires)
        .filter(
          (row) => row.role === "squire" && row.status === "active" && row.lifecycle === "ready",
        )
        .map((row) => row.id),
    );
    if (active.size === 0) return [];
    const dismissed = new Set(
      (yield* repository.listCards({ squireId: lead.id, statuses: ["dismissed"] })).flatMap(
        (card) => (card.finding_key === null ? [] : [card.finding_key]),
      ),
    );
    const nowMs = DateTime.toEpochMillis(now);
    const found: Array<SquireSweepCandidate & { at: number }> = [];
    for (const shell of (yield* projections.getShellSnapshot({ location: "active" })).threads) {
      if (isSquireThread(shell) || shell.archivedAt !== null) continue;
      if (!(shell.pullRequests ?? []).some((link) => link.snapshot?.state === "open")) continue;
      const trackers = yield* scope.trackersOf(shell.id);
      if (!trackers.some((id) => active.has(id))) continue;
      const candidate = yield* candidateFor(shell, nowMs, dismissed);
      if (Option.isNone(candidate) || (yield* hasOpenDecision(shell.id))) continue;
      found.push(candidate.value);
    }
    return found
      .toSorted(
        (a, b) =>
          Number(b.kind === "failing-checks-no-turn") -
            Number(a.kind === "failing-checks-no-turn") || a.at - b.at,
      )
      .slice(0, SQUIRE_SWEEP_MAX_CANDIDATES)
      .map(({ at: _at, ...candidate }) => candidate);
  });

  const logRan = (
    lead: SquireRepository.SquireRow,
    data: typeof RanData.Type,
    now: DateTime.Utc,
    eventId: number | null = null,
  ) =>
    repository.insertActionLog({
      squire_id: lead.id,
      kind: RAN,
      room_id: null,
      post_id: null,
      trigger_id: null,
      task_id: null,
      thread_id: null,
      card_id: null,
      event_id: eventId,
      run_id: null,
      invocation_key: null,
      execution_key: null,
      data_json: encodeRan(data),
      created_at: DateTime.formatIso(now),
    });

  const resultOf = (data: typeof RanData.Type): SweepResult => ({
    outcome: data.outcome,
    retryAt: data.retryAt ?? null,
  });

  /** One sweep: dedupe on its key, then the sweeps-per-day budget, then the event or the empty row. */
  const run = Effect.fn("SquireSweep.run")(function* (
    lead: SquireRepository.SquireRow,
    sweepKey: string,
    source: SweepSource,
    now: DateTime.Utc,
  ) {
    const found = yield* candidates(lead, now);
    const result = yield* runLock(
      repository.transaction(
        Effect.gen(function* () {
          const ran = yield* ranRows(lead.id, now, source === "request" ? 30 * DAY_MS : 2 * DAY_MS);
          const previous = ran.find((entry) => entry.data.sweepKey === sweepKey);
          if (previous !== undefined) return { result: resultOf(previous.data), queued: false };
          const day = ran.filter(
            (entry) =>
              entry.data.outcome === "queued" && entry.row.created_at > minusMs(now, DAY_MS),
          );
          const limit = settingsOf(lead).sweepsPerDay;
          if (day.length >= limit) {
            // The window frees when the oldest sweep filling it ages out.
            const oldest = day.at(-limit) ?? day[0];
            const retryAt = oldest === undefined ? null : isoPlus(oldest.row.created_at, DAY_MS);
            const data = {
              sweepKey,
              source,
              outcome: "budget-reached",
              candidates: 0,
              retryAt,
            } as const;
            yield* logRan(lead, data, now);
            return { result: resultOf(data), queued: false };
          }
          if (found.length === 0) {
            const data = { sweepKey, source, outcome: "empty", candidates: 0 } as const;
            yield* logRan(lead, data, now);
            return { result: resultOf(data), queued: false };
          }
          const at = DateTime.formatIso(now);
          const eventId = yield* repository.insertTriggerEvent({
            squire_id: lead.id,
            thread_id: null,
            kind: "sweep-due",
            state_key: sweepKey,
            payload_json: encodeEvent({ type: "sweep-due", sweepKey, source, candidates: found }),
            status: "pending",
            defer_reason: null,
            not_before: at,
            batch_id: null,
            created_at: at,
          });
          const data = { sweepKey, source, outcome: "queued", candidates: found.length } as const;
          yield* logRan(lead, data, now, Option.getOrNull(eventId));
          return { result: resultOf(data), queued: true };
        }),
      ),
    );
    if (result.queued && Option.isSome(delivery)) yield* delivery.value.wake(lead.id);
    return result.result;
  });

  const due: SquireSweep["Service"]["due"] = Effect.fn("SquireSweep.due")(function* (now) {
    const lead = yield* repository.getLead;
    if (Option.isNone(lead)) return;
    const slot = yield* dueSlot(lead.value, now);
    if (Option.isNone(slot)) return;
    yield* run(lead.value, scheduleKey(slot.value), "schedule", now);
  }, orSquireError("run the scheduled sweep"));

  const nextDueAt: SquireSweep["Service"]["nextDueAt"] = Effect.fn("SquireSweep.nextDueAt")(
    function* (now) {
      const lead = yield* repository.getLead;
      if (!(yield* enabled) || Option.isNone(lead) || !sweeping(lead.value)) return Option.none();
      if (Option.isSome(yield* dueSlot(lead.value, now))) return Option.some(now);
      return slotsAround(lead.value, now).next;
    },
    orSquireError("read the next sweep slot"),
  );

  const request: SquireSweep["Service"]["request"] = Effect.fn("SquireSweep.request")(function* (
    input,
  ) {
    if (!(yield* enabled)) {
      return yield* new SquireError({
        code: "disabled_by_server",
        message: "Squires are turned off on this server.",
      });
    }
    const lead = yield* repository.getLead;
    if (Option.isNone(lead) || lead.value.lifecycle === "deleting") {
      return yield* new SquireError({ code: "not_found", message: "There is no Lead yet." });
    }
    if (!sweeping(lead.value)) return { outcome: "paused", retryAt: null } satisfies SweepResult;
    return yield* run(lead.value, `request:${input.requestId}`, "request", yield* DateTime.now);
  }, orSquireError("find work"));

  const refusal = (reason: SquireSweepRefusal, text: string): SquireSweepAdmission => ({
    ok: false,
    reason,
    text,
  });

  const admitFinding: SquireSweep["Service"]["admitFinding"] = Effect.fn(
    "SquireSweep.admitFinding",
  )(function* (input) {
    const { lead } = input;
    if (!sweeping(lead)) {
      return refusal("paused", "The sweep is paused, so no finding was raised.");
    }
    const sweep = input.batchEvents
      .filter((row) => row.kind === "sweep-due")
      .flatMap((row) =>
        Option.toArray(decodeEvent(row.payload_json ?? "")).flatMap((event) =>
          !isUnknownUnionMember(event) && event.type === "sweep-due" ? [event] : [],
        ),
      )
      .at(-1);
    if (sweep === undefined) {
      return refusal("not-a-sweep", "Findings are raised only in a sweep turn.");
    }
    const candidate = sweep.candidates.find((entry) => entry.threadId === input.threadId);
    if (candidate === undefined) {
      return refusal(
        "not-a-candidate",
        "A finding must be about one of this sweep's candidate threads.",
      );
    }
    const findingKey = findingKeyOf(candidate);
    const findings = (yield* repository.listCards({ squireId: lead.id })).filter(
      (card) => card.finding_key !== null,
    );
    const same = findings.filter((card) => card.finding_key === findingKey);
    if (same.some((card) => card.status === "dismissed")) {
      return refusal("finding-dismissed", "The user already dismissed this finding.");
    }
    if (same.some((card) => (OPEN_STATUSES as ReadonlyArray<string>).includes(card.status))) {
      return refusal("already-raised", "This finding is already in the queue.");
    }
    const settings = settingsOf(lead);
    const inSweep = findings.filter((card) =>
      Option.exists(
        decodeTrigger(card.trigger_json),
        (trigger) => trigger.requestId === sweep.sweepKey,
      ),
    );
    if (inSweep.length >= settings.findingsPerSweep) {
      return refusal(
        "sweep-findings-reached",
        `This sweep already raised ${inSweep.length} finding${inSweep.length === 1 ? "" : "s"}, its limit.`,
      );
    }
    const dayStart = isoPlus(input.now, -DAY_MS);
    const today = findings.filter((card) => card.created_at > dayStart);
    if (today.length >= settings.findingsPerDay) {
      const oldest = today.at(-settings.findingsPerDay) ?? today[0];
      const until = oldest === undefined ? input.now : isoPlus(oldest.created_at, DAY_MS);
      return refusal("daily-findings-reached", `Sweep finding budget reached until ${until}.`);
    }
    const trigger: SquireCardTrigger = { requestId: sweep.sweepKey };
    if (candidate.kind !== "failing-checks-no-turn" || candidate.headSha === null) {
      return {
        ok: true,
        findingKey,
        trigger: candidate.headSha === null ? trigger : { ...trigger, headSha: candidate.headSha },
      };
    }
    // The reactor outdates the finding when this PR leaves the failing state on this head.
    const shell = yield* projections
      .getThreadShell(candidate.threadId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const link = (shell?.pullRequests ?? []).find(
      (entry) => entry.number === candidate.pullRequestNumber,
    );
    return {
      ok: true,
      findingKey,
      trigger: {
        ...trigger,
        headSha: candidate.headSha,
        transition: "checks:failed",
        ...(link === undefined ? {} : { prKey: threadPullRequestKeyOf(link) }),
      },
    };
  });

  const outcomeOf = (card: SquireRepository.SquireCardRow) =>
    card.status === "dismissed"
      ? ("dismissed" as const)
      : card.status === "outdated"
        ? ("outdated" as const)
        : ("accepted" as const);

  const recordFor = Effect.fn("SquireSweep.recordFor")(function* (
    lead: SquireId,
    now: DateTime.Utc,
  ) {
    const since = minusMs(now, OUTCOME_LOOKBACK_MS);
    const finished = (yield* repository.listCards({
      squireId: lead,
      statuses: [...FINAL_STATUSES],
    })).filter((card) => card.finding_key !== null && card.updated_at >= since);
    if (finished.length === 0) return 0;
    const oldest = finished.map((card) => card.created_at).toSorted()[0] ?? since;
    return yield* repository.transaction(
      Effect.gen(function* () {
        const logged = new Set(
          (yield* repository.listActionLogAfter({
            squireId: lead,
            kinds: [FINDING],
            after: isoPlus(oldest, -1),
          })).map((row) => row.card_id),
        );
        const missing = finished.filter((card) => !logged.has(card.id));
        for (const card of missing) {
          yield* repository.insertActionLog({
            squire_id: lead,
            kind: FINDING,
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
            data_json: encodeFinding({
              outcome: outcomeOf(card),
              findingKey: card.finding_key ?? "",
            }),
            // The outcome counts on the day it happened.
            created_at: card.updated_at,
          });
        }
        return missing.length;
      }),
    );
  });

  const recordOutcomes: SquireSweep["Service"]["recordOutcomes"] = Effect.fn(
    "SquireSweep.recordOutcomes",
  )(function* (now) {
    const lead = yield* repository.getLead;
    return Option.isNone(lead) ? 0 : yield* recordFor(lead.value.id, now);
  }, orSquireError("record sweep outcomes"));

  const acceptanceRate: SquireSweep["Service"]["acceptanceRate"] = Effect.fn(
    "SquireSweep.acceptanceRate",
  )(function* (leadId, now) {
    yield* recordFor(leadId, now);
    const rows = yield* repository.listActionLogAfter({
      squireId: leadId,
      kinds: [FINDING],
      after: minusMs(now, ACCEPTANCE_WINDOW_MS),
    });
    const outcomes = rows.flatMap((row) => Option.toArray(decodeFinding(row.data_json)));
    return {
      accepted: outcomes.filter((data) => data.outcome === "accepted").length,
      total: outcomes.length,
    };
  }, orSquireError("read the sweep acceptance rate"));

  return SquireSweep.of({
    due,
    nextDueAt,
    request,
    admitFinding,
    recordOutcomes,
    acceptanceRate,
  });
});

export const layer = Layer.effect(SquireSweep, make);
