// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no random bytes or synchronous hash.
import * as NodeCrypto from "node:crypto";

import {
  DEFAULT_SQUIRE_PERMISSIONS,
  SQUIRE_MAX_TRIGGERS,
  type SquireAutomationResumeInput,
  type SquireAutomationResumeResult,
  SquireCardId,
  SquireCardPayload,
  SquireEnvironmentSettings,
  SquireError,
  SquireEvent,
  type SquireId,
  SquirePermissions,
  SquireTrigger,
  type SquireTriggerCreateInput,
  type SquireTriggerCreateResult,
  SquireTriggerId,
  type SquireTriggerResult,
  type SquireTriggerRevokeInput,
  type SquireTriggerRotateInput,
  type SquireTriggerRotateResult,
  SquireTriggerSchedule,
  type SquireTriggerTestInput,
  type SquireTriggerTestResult,
  type SquireTriggerUpdateInput,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import {
  constantTimeEquals,
  verifyWebhookSignature,
} from "../scheduledTasks/webhookVerification.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireRepository from "./SquireRepository.ts";
import { touchUserActivity } from "./squireUserActivity.ts";

const RUNS_PER_TRIGGER_PER_HOUR = 6;
const RUNS_PER_SQUIRE_PER_DAY = 48;
const MAX_BODY_BYTES = 64 * 1024;
const EXCERPT_MAX_CHARS = 2000;
const DELIVERY_ID_MAX_CHARS = 200;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEKDAYS = [1, 2, 3, 4, 5];

/** How long the inactivity FYI waits for an answer before triggers and the sweep pause. */
const INACTIVITY_ANSWER_MS = 48 * HOUR_MS;
const INACTIVITY_TITLE = "Keep Squire triggers running?";

const RECEIVED = "trigger.received";
const RATE_LIMITED = "trigger.rate-limited";
const REJECTED = "trigger.rejected";

type RunOrigin = "schedule" | "webhook" | "test";
type Limit = { readonly limit: "hour" | "day"; readonly until: string };
type Admission =
  | { readonly outcome: "queued" }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "rate_limited"; readonly retryAt: string };
type TriggerEvent = Extract<SquireEvent, { readonly type: "schedule-due" | "webhook-received" }>;
type WebhookReceipt = Admission | { readonly outcome: "not_found" | "unauthorized" | "too_large" };

export class SquireTriggers extends Context.Service<
  SquireTriggers,
  {
    readonly list: (squireId: SquireId) => Effect.Effect<ReadonlyArray<SquireTrigger>, SquireError>;
    /**
     * At most 5 live triggers per Squire, none on the Lead. A webhook's secret
     * is returned here once; a replayed request id returns the stored trigger
     * without it.
     */
    readonly create: (
      input: typeof SquireTriggerCreateInput.Type,
    ) => Effect.Effect<typeof SquireTriggerCreateResult.Type, SquireError>;
    /** Pause, resume, or edit. A resume or schedule edit re-arms from now, so a pause never fires its missed slot. */
    readonly update: (
      input: typeof SquireTriggerUpdateInput.Type,
    ) => Effect.Effect<typeof SquireTriggerResult.Type, SquireError>;
    readonly rotate: (
      input: typeof SquireTriggerRotateInput.Type,
    ) => Effect.Effect<typeof SquireTriggerRotateResult.Type, SquireError>;
    /** Idempotent. */
    readonly revoke: (
      input: typeof SquireTriggerRevokeInput.Type,
    ) => Effect.Effect<typeof SquireTriggerResult.Type, SquireError>;
    /** Test now: one event keyed `test:<requestId>`, counted toward the run limits. */
    readonly test: (
      input: typeof SquireTriggerTestInput.Type,
    ) => Effect.Effect<typeof SquireTriggerTestResult.Type, SquireError>;
    /**
     * One schedule-due row per due trigger, for its latest missed slot, with
     * `next_slot_at` advanced in the same transaction. Returns the rows queued.
     */
    readonly fireDueSlots: (now: DateTime.Utc) => Effect.Effect<number, SquireError>;
    /** The earliest slot among triggers that can fire now, for SquireClock to arm on. */
    readonly earliestSlotAt: Effect.Effect<Option.Option<DateTime.Utc>, SquireError>;
    /**
     * Webhook receipt. `body` is read only once the trigger is known to
     * accept requests; a failed read counts as too large, since the route caps
     * its reader.
     */
    readonly receive: <E>(
      triggerId: string,
      headers: Readonly<Record<string, string>>,
      body: Effect.Effect<Uint8Array, E>,
    ) => Effect.Effect<WebhookReceipt, SquireError>;
    /**
     * From the clock's sweep: after `squire.inactivityDays` without user
     * activity, one FYI on the Lead; 48 h without an answer sets
     * `automation_paused_at` and tells the Lead's thread.
     */
    readonly checkInactivity: (now: DateTime.Utc) => Effect.Effect<void, SquireError>;
    /**
     * The inactivity FYI's Keep (accept) or Pause (dismiss); closes the card
     * if still open. Keep after the pause resumes everything.
     */
    readonly answerInactivity: (input: {
      readonly keep: boolean;
    }) => Effect.Effect<void, SquireError>;
    /**
     * Ends the inactivity pause. With `triggerIds`, only those triggers run
     * again and the other live ones are paused one by one. Slots re-arm from
     * now, so no missed slot fires.
     */
    readonly resumeAutomation: (
      input: typeof SquireAutomationResumeInput.Type,
    ) => Effect.Effect<typeof SquireAutomationResumeResult.Type, SquireError>;
  }
>()("lecturn/squire/SquireTriggers") {}

const decodeTrigger = Schema.decodeUnknownEffect(SquireTrigger);
const decodeTriggerId = Schema.decodeUnknownOption(SquireTriggerId);
const decodeSchedule = Schema.decodeUnknownEffect(Schema.fromJsonString(SquireTriggerSchedule));
const encodeSchedule = Schema.encodeSync(Schema.fromJsonString(SquireTriggerSchedule));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const LogData = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const encodeLogData = Schema.encodeSync(LogData);
const decodeLogData = Schema.decodeUnknownOption(LogData);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodePermissions = Schema.decodeUnknownOption(Schema.fromJsonString(SquirePermissions));
const encodeCardPayload = Schema.encodeSync(Schema.fromJsonString(SquireCardPayload));
const encodeSquireSettings = Schema.encodeSync(Schema.fromJsonString(SquireEnvironmentSettings));

const refuse = (code: SquireError["code"], message: string) => new SquireError({ code, message });
const notFound = refuse("not_found", "This trigger no longer exists.");

const secretRef = (triggerId: SquireTriggerId, generation: number) =>
  `squire-trigger:${triggerId}:${generation}`;
const hookPath = (triggerId: SquireTriggerId) => `/api/squire/hooks/${triggerId}`;
// The id is derived from the request id so a replayed create finds its row,
// and stays URL-safe because it is the webhook path.
const triggerIdFor = (squireId: SquireId, requestId: string) =>
  SquireTriggerId.make(
    `trigger-${NodeCrypto.createHash("sha256").update(`${squireId}\0${requestId}`).digest("hex").slice(0, 32)}`,
  );
const newSecret = () => NodeCrypto.randomBytes(32).toString("base64url");

const truncate = (text: string, max: number) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};
/** JSON bodies are re-serialized compactly so the excerpt carries more of the payload. */
const excerptOf = (text: string) =>
  truncate(
    Option.match(decodeJson(text), { onNone: () => text, onSome: (v) => JSON.stringify(v) }),
    EXCERPT_MAX_CHARS,
  );

const lowerCaseHeaders = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

const deliveryIdOf = (headers: Readonly<Record<string, string>>) => {
  for (const name of ["idempotency-key", "x-github-delivery"]) {
    const value = headers[name]?.trim();
    if (value) return truncate(value, DELIVERY_ID_MAX_CHARS);
  }
  return `server-${NodeCrypto.randomUUID()}`;
};

const authorized = (
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
  secret: string,
) => {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(headers["authorization"] ?? "")?.[1];
  if (bearer !== undefined && constantTimeEquals(bearer, secret)) return true;
  return verifyWebhookSignature({
    signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
    secret,
    headers,
    body,
  });
};

const plusMs = (iso: string, ms: number) =>
  DateTime.formatIso(DateTime.addDuration(DateTime.makeUnsafe(iso), ms));

const inactivityCardPrefix = (leadId: SquireId) => `card:fyi:${leadId}:inactivity:`;

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const { withPolicyLock } = yield* SquirePolicyLock.SquirePolicyLock;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  // The service is only built with the switch on; a missing config reads as off.
  const enabled = Option.isSome(config) && config.value.squireEnabled;
  // The last `squire` settings block the sweep saw; a change is the user acting.
  const lastSquireSettings = yield* Ref.make(Option.none<string>());
  // Orders the count-then-insert of run admission, which the limits depend on.
  const runLock = (yield* Semaphore.make(1)).withPermits(1);

  const nowUtc = DateTime.now;
  const requireEnabled = enabled
    ? Effect.void
    : Effect.fail(refuse("disabled_by_server", "Squires are turned off on this server."));

  const leadZone = repository.getLead.pipe(
    Effect.map((lead) =>
      Option.getOrElse(
        Option.flatMap(
          Option.flatMapNullishOr(lead, (row) => row.timezone),
          DateTime.zoneMakeNamed,
        ),
        DateTime.zoneMakeLocal,
      ),
    ),
  );

  const nextSlot = (
    schedule: SquireTriggerSchedule,
    from: DateTime.Utc,
    zone: DateTime.TimeZone,
  ) => {
    if (schedule.kind === "interval") {
      return Option.some(DateTime.addDuration(from, schedule.hours * HOUR_MS));
    }
    const next = nextScheduledRunAt(
      {
        type: "fixed_time",
        timeOfDay: schedule.time,
        ...(schedule.weekdaysOnly ? { weekdays: WEEKDAYS } : {}),
      },
      DateTime.setZone(from, zone),
    );
    return next === null ? Option.none() : Option.some(DateTime.toUtc(next));
  };

  /** The latest slot at or before `now`, starting from a due `next`, and the slot after it. */
  const latestDueSlot = (
    schedule: SquireTriggerSchedule,
    next: DateTime.Utc,
    now: DateTime.Utc,
    zone: DateTime.TimeZone,
  ) => {
    if (schedule.kind === "interval") {
      const period = schedule.hours * HOUR_MS;
      const missed = Math.floor(
        (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(next)) / period,
      );
      const slot = DateTime.addDuration(next, missed * period);
      return { slot, following: Option.some(DateTime.addDuration(slot, period)) };
    }
    let slot = next;
    let following = nextSlot(schedule, slot, zone);
    while (Option.isSome(following) && DateTime.isLessThanOrEqualTo(following.value, now)) {
      slot = following.value;
      following = nextSlot(schedule, slot, zone);
    }
    return { slot, following };
  };

  /** The Squire when its triggers may fire: switch on, active, not the Lead, no inactivity pause. */
  const firingSquire = (squireId: SquireId) =>
    Effect.gen(function* () {
      if (!enabled) return Option.none();
      const squire = yield* repository.getSquire(squireId);
      if (
        Option.isNone(squire) ||
        squire.value.role === "lead" ||
        squire.value.status !== "active" ||
        squire.value.lifecycle === "deleting"
      ) {
        return Option.none();
      }
      const lead = yield* repository.getLead;
      if (Option.isSome(lead) && lead.value.automation_paused_at !== null) return Option.none();
      return squire;
    });

  /** The limit that holds at `now`, if any, and whether its window already has its log row. */
  const limitAt = (row: SquireRepository.SquireTriggerRow, now: DateTime.Utc) =>
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(now);
      const log = yield* repository.listActionLogAfter({
        squireId: row.squire_id,
        kinds: [RECEIVED, RATE_LIMITED],
        after: DateTime.formatIso(DateTime.makeUnsafe(nowMs - DAY_MS)),
      });
      const runs = log.filter((entry) => entry.kind === RECEIVED);
      const hourStart = DateTime.formatIso(DateTime.makeUnsafe(nowMs - HOUR_MS));
      const hourRuns = runs.filter(
        (entry) => entry.trigger_id === row.id && entry.created_at > hourStart,
      );
      // A window ends when the oldest run that fills the cap ages out of it.
      const limits: Array<Limit> = [];
      const hourOldest = hourRuns.at(-RUNS_PER_TRIGGER_PER_HOUR);
      if (hourRuns.length >= RUNS_PER_TRIGGER_PER_HOUR && hourOldest !== undefined) {
        limits.push({ limit: "hour", until: plusMs(hourOldest.created_at, HOUR_MS) });
      }
      const dayOldest = runs.at(-RUNS_PER_SQUIRE_PER_DAY);
      if (runs.length >= RUNS_PER_SQUIRE_PER_DAY && dayOldest !== undefined) {
        limits.push({ limit: "day", until: plusMs(dayOldest.created_at, DAY_MS) });
      }
      const limit = limits.toSorted((a, b) => b.until.localeCompare(a.until))[0];
      if (limit === undefined) return Option.none();
      const logged = log.some(
        (entry) =>
          entry.kind === RATE_LIMITED &&
          (limit.limit === "day" || entry.trigger_id === row.id) &&
          Option.exists(
            decodeLogData(entry.data_json),
            (data) => data.limit === limit.limit && data.until === limit.until,
          ),
      );
      return Option.some({ ...limit, logged });
    });

  const logRow = (
    row: SquireRepository.SquireTriggerRow,
    kind: string,
    data: Record<string, string>,
    at: DateTime.Utc,
    eventId: number | null = null,
  ) =>
    repository.insertActionLog({
      squire_id: row.squire_id,
      kind,
      room_id: null,
      post_id: null,
      trigger_id: row.id,
      task_id: null,
      thread_id: null,
      card_id: null,
      event_id: eventId,
      run_id: null,
      invocation_key: null,
      execution_key: null,
      data_json: encodeLogData(data),
      created_at: DateTime.formatIso(at),
    });

  /**
   * Dedupe, then limits, then the pending row and its `trigger.received`.
   * Callers hold `runLock` inside one transaction, so the count stays exact.
   */
  const admit = (input: {
    readonly row: SquireRepository.SquireTriggerRow;
    readonly origin: RunOrigin;
    readonly stateKey: string;
    readonly event: TriggerEvent;
    readonly now: DateTime.Utc;
  }) =>
    Effect.gen(function* () {
      const { row, now } = input;
      const key = { squireId: row.squire_id, kind: input.event.type, stateKey: input.stateKey };
      if (yield* repository.hasThreadlessEvent(key)) return { outcome: "duplicate" } as Admission;
      const limit = yield* limitAt(row, now);
      if (Option.isSome(limit)) {
        if (!limit.value.logged) {
          yield* logRow(
            row,
            RATE_LIMITED,
            { origin: input.origin, limit: limit.value.limit, until: limit.value.until },
            now,
          );
        }
        return { outcome: "rate_limited", retryAt: limit.value.until } as Admission;
      }
      const at = DateTime.formatIso(now);
      const eventId = yield* repository.insertTriggerEvent({
        squire_id: row.squire_id,
        thread_id: null,
        kind: input.event.type,
        state_key: input.stateKey,
        payload_json: encodeEvent(input.event),
        status: "pending",
        defer_reason: null,
        not_before: at,
        batch_id: null,
        created_at: at,
      });
      if (Option.isNone(eventId)) return { outcome: "duplicate" } as Admission;
      yield* logRow(row, RECEIVED, { origin: input.origin }, now, eventId.value);
      return { outcome: "queued" } as Admission;
    });

  const toTrigger = (row: SquireRepository.SquireTriggerRow, now: DateTime.Utc) =>
    Effect.gen(function* () {
      const limit = row.status === "revoked" ? Option.none() : yield* limitAt(row, now);
      return yield* decodeTrigger({
        id: row.id,
        squireId: row.squire_id,
        name: row.name,
        kind: row.kind,
        instruction: row.instruction,
        status: row.status,
        schedule: row.schedule_json === null ? null : yield* decodeSchedule(row.schedule_json),
        nextSlotAt: row.next_slot_at,
        secretGeneration: row.secret_generation,
        limitedUntil: Option.match(limit, { onNone: () => null, onSome: (l) => l.until }),
        createdAt: row.created_at,
      });
    });

  const requireTrigger = (triggerId: SquireTriggerId) =>
    repository
      .getTrigger(triggerId)
      .pipe(
        Effect.flatMap((row) =>
          Option.isNone(row) || row.value.status === "revoked"
            ? Effect.fail(notFound)
            : Effect.succeed(row.value),
        ),
      );

  const removeSecret = (ref: string | null) =>
    ref === null
      ? Effect.void
      : secrets
          .remove(ref)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not delete a Squire trigger secret", { cause }),
            ),
          );

  /** Stores a fresh secret under the generation's ref; `set` so a retried step overwrites its own leftover. */
  const storeSecret = (triggerId: SquireTriggerId, generation: number) =>
    Effect.gen(function* () {
      const secret = newSecret();
      const ref = secretRef(triggerId, generation);
      yield* secrets.set(ref, new TextEncoder().encode(secret));
      return { secret, ref };
    });

  const list: SquireTriggers["Service"]["list"] = (squireId) =>
    Effect.gen(function* () {
      const now = yield* nowUtc;
      const rows = yield* repository.listTriggers(squireId);
      return yield* Effect.forEach(rows, (row) => toTrigger(row, now));
    }).pipe(orSquireError("read the Squire's triggers"));

  const create: SquireTriggers["Service"]["create"] = (input) =>
    requireEnabled.pipe(
      Effect.andThen(
        withPolicyLock(
          Effect.gen(function* () {
            const squire = yield* repository.getSquire(input.squireId);
            if (Option.isNone(squire) || squire.value.lifecycle === "deleting") {
              return yield* refuse("not_found", "This Squire no longer exists.");
            }
            if (squire.value.role === "lead") {
              return yield* refuse("invalid_request", "The Lead has no triggers.");
            }
            const id = triggerIdFor(input.squireId, input.requestId);
            const now = yield* nowUtc;
            const existing = yield* repository.getTrigger(id);
            if (Option.isSome(existing)) {
              return { trigger: yield* toTrigger(existing.value, now), webhook: null };
            }
            const live = (yield* repository.listTriggers(input.squireId)).filter(
              (row) => row.status !== "revoked",
            );
            if (live.length >= SQUIRE_MAX_TRIGGERS) {
              return yield* refuse("limit_reached", "Trigger limit reached; remove one in setup");
            }
            const base = {
              id,
              squire_id: input.squireId,
              name: input.name,
              instruction: input.instruction,
              status: "active" as const,
              secret_generation: 0,
              last_payload_excerpt: null,
              created_at: DateTime.formatIso(now),
            };
            if (input.kind === "schedule") {
              const zone = yield* leadZone;
              const row: SquireRepository.SquireTriggerRow = {
                ...base,
                kind: "schedule",
                schedule_json: encodeSchedule(input.schedule),
                next_slot_at: Option.match(nextSlot(input.schedule, now, zone), {
                  onNone: () => null,
                  onSome: DateTime.formatIso,
                }),
                secret_ref: null,
              };
              yield* repository.insertTrigger(row);
              return { trigger: yield* toTrigger(row, now), webhook: null };
            }
            const { secret, ref } = yield* storeSecret(id, 0);
            const row: SquireRepository.SquireTriggerRow = {
              ...base,
              kind: "webhook",
              schedule_json: null,
              next_slot_at: null,
              secret_ref: ref,
            };
            yield* repository.insertTrigger(row).pipe(Effect.onError(() => removeSecret(ref)));
            return {
              trigger: yield* toTrigger(row, now),
              webhook: { secret, path: hookPath(id) },
            };
          }),
        ),
      ),
      touched,
      orSquireError("create the trigger"),
    );

  const update: SquireTriggers["Service"]["update"] = (input) =>
    requireEnabled.pipe(
      Effect.andThen(
        withPolicyLock(
          Effect.gen(function* () {
            const row = yield* requireTrigger(input.triggerId);
            if (input.schedule !== undefined && row.kind !== "schedule") {
              return yield* refuse("invalid_request", "Only a schedule trigger has a schedule.");
            }
            const now = yield* nowUtc;
            const status = input.status ?? row.status;
            let nextSlotAt = row.next_slot_at;
            if (row.kind === "schedule") {
              if (status !== "active") {
                nextSlotAt = null;
              } else if (input.schedule !== undefined || row.status !== "active") {
                const schedule =
                  input.schedule ??
                  (row.schedule_json === null ? null : yield* decodeSchedule(row.schedule_json));
                nextSlotAt =
                  schedule === null
                    ? null
                    : Option.match(nextSlot(schedule, now, yield* leadZone), {
                        onNone: () => null,
                        onSome: DateTime.formatIso,
                      });
              }
            }
            const updated = yield* repository.updateTrigger({
              id: row.id,
              patch: {
                status,
                next_slot_at: nextSlotAt,
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
                ...(input.schedule === undefined
                  ? {}
                  : { schedule_json: encodeSchedule(input.schedule) }),
              },
            });
            if (Option.isNone(updated)) return yield* notFound;
            return { trigger: yield* toTrigger(updated.value, now) };
          }),
        ),
      ),
      touched,
      orSquireError("update the trigger"),
    );

  const rotate: SquireTriggers["Service"]["rotate"] = (input) =>
    requireEnabled.pipe(
      Effect.andThen(
        withPolicyLock(
          Effect.gen(function* () {
            const row = yield* requireTrigger(input.triggerId);
            if (row.kind !== "webhook") {
              return yield* refuse("invalid_request", "Only a webhook trigger has a secret.");
            }
            const generation = row.secret_generation + 1;
            const { secret, ref } = yield* storeSecret(row.id, generation);
            const updated = yield* repository
              .updateTrigger({
                id: row.id,
                patch: { secret_ref: ref, secret_generation: generation },
              })
              .pipe(Effect.onError(() => removeSecret(ref)));
            if (Option.isNone(updated)) return yield* notFound;
            // The row no longer names the old ref, so it stops admitting even if this delete fails.
            yield* removeSecret(row.secret_ref);
            return {
              trigger: yield* toTrigger(updated.value, yield* nowUtc),
              webhook: { secret, path: hookPath(row.id) },
            };
          }),
        ),
      ),
      touched,
      orSquireError("rotate the trigger's secret"),
    );

  const revoke: SquireTriggers["Service"]["revoke"] = (input) =>
    requireEnabled.pipe(
      Effect.andThen(
        withPolicyLock(
          Effect.gen(function* () {
            const row = yield* repository.getTrigger(input.triggerId);
            if (Option.isNone(row)) return yield* notFound;
            const now = yield* nowUtc;
            if (row.value.status === "revoked")
              return { trigger: yield* toTrigger(row.value, now) };
            const updated = yield* repository.updateTrigger({
              id: row.value.id,
              patch: { status: "revoked", next_slot_at: null, secret_ref: null },
            });
            if (Option.isNone(updated)) return yield* notFound;
            yield* removeSecret(row.value.secret_ref);
            return { trigger: yield* toTrigger(updated.value, now) };
          }),
        ),
      ),
      touched,
      orSquireError("revoke the trigger"),
    );

  const test: SquireTriggers["Service"]["test"] = (input) =>
    requireEnabled.pipe(
      Effect.andThen(
        withPolicyLock(
          Effect.gen(function* () {
            const row = yield* requireTrigger(input.triggerId);
            const squire = yield* repository.getSquire(row.squire_id);
            if (Option.isNone(squire) || squire.value.lifecycle === "deleting") {
              return yield* refuse("not_found", "This Squire no longer exists.");
            }
            if (squire.value.status !== "active") {
              return yield* refuse("paused", "Resume this Squire to test its triggers.");
            }
            const now = yield* nowUtc;
            // Delivery reads origin `test` from this prefix.
            const stateKey = `test:${input.requestId}`;
            const event: TriggerEvent =
              row.kind === "schedule"
                ? {
                    type: "schedule-due",
                    triggerId: row.id,
                    slot: DateTime.formatIso(now),
                    instruction: row.instruction,
                  }
                : {
                    type: "webhook-received",
                    triggerId: row.id,
                    deliveryId: stateKey,
                    instruction: row.instruction,
                    payloadExcerpt:
                      input.samplePayload === undefined
                        ? (row.last_payload_excerpt ?? "")
                        : excerptOf(input.samplePayload),
                  };
            const admission = yield* runLock(
              repository.transaction(admit({ row, origin: "test", stateKey, event, now })),
            );
            return admission.outcome === "rate_limited"
              ? { outcome: "rate-limited" as const, retryAt: admission.retryAt }
              : { outcome: "queued" as const, retryAt: null };
          }),
        ),
      ),
      touched,
      orSquireError("test the trigger"),
    );

  const fireSlot = (triggerId: SquireTriggerId, now: DateTime.Utc) =>
    runLock(
      repository.transaction(
        Effect.gen(function* () {
          // Re-read under the lock: a concurrent pause or edit wins.
          const current = yield* repository.getTrigger(triggerId);
          if (Option.isNone(current)) return false;
          const row = current.value;
          const { schedule_json: scheduleJson, next_slot_at: nextSlotAt } = row;
          if (
            row.status !== "active" ||
            scheduleJson === null ||
            nextSlotAt === null ||
            nextSlotAt > DateTime.formatIso(now)
          ) {
            return false;
          }
          const { slot, following } = latestDueSlot(
            yield* decodeSchedule(scheduleJson),
            DateTime.makeUnsafe(nextSlotAt),
            now,
            yield* leadZone,
          );
          const slotIso = DateTime.formatIso(slot);
          const admission = yield* admit({
            row,
            origin: "schedule",
            stateKey: `${row.id}:${slotIso}`,
            event: {
              type: "schedule-due",
              triggerId: row.id,
              slot: slotIso,
              instruction: row.instruction,
            },
            now,
          });
          yield* repository.updateTrigger({
            id: row.id,
            patch: {
              next_slot_at: Option.match(following, {
                onNone: () => null,
                onSome: DateTime.formatIso,
              }),
            },
          });
          return admission.outcome === "queued";
        }),
      ),
    );

  const fireDueSlots: SquireTriggers["Service"]["fireDueSlots"] = (now) =>
    Effect.gen(function* () {
      if (!enabled) return 0;
      const nowIso = DateTime.formatIso(now);
      const due = (yield* repository.listArmedTriggers).filter(
        (row) => row.next_slot_at !== null && row.next_slot_at <= nowIso,
      );
      let queued = 0;
      for (const row of due) {
        // A blocked trigger keeps its slot, so after a resume it fires once, like downtime.
        if (Option.isNone(yield* firingSquire(row.squire_id))) continue;
        if (yield* fireSlot(row.id, now)) queued += 1;
      }
      return queued;
    }).pipe(orSquireError("fire the due triggers"));

  const earliestSlotAt: SquireTriggers["Service"]["earliestSlotAt"] = Effect.gen(function* () {
    if (!enabled) return Option.none();
    for (const row of yield* repository.listArmedTriggers) {
      if (row.next_slot_at !== null && Option.isSome(yield* firingSquire(row.squire_id))) {
        return Option.some(DateTime.makeUnsafe(row.next_slot_at));
      }
    }
    return Option.none();
  }).pipe(orSquireError("read the next trigger slot"));

  const receive: SquireTriggers["Service"]["receive"] = (rawTriggerId, rawHeaders, body) =>
    Effect.gen(function* () {
      const missing = { outcome: "not_found" } as const;
      if (!enabled) return missing;
      const triggerId = decodeTriggerId(rawTriggerId);
      if (Option.isNone(triggerId)) return missing;
      const found = yield* repository.getTrigger(triggerId.value);
      if (
        Option.isNone(found) ||
        found.value.kind !== "webhook" ||
        found.value.status !== "active" ||
        found.value.secret_ref === null
      ) {
        return missing;
      }
      const row = found.value;
      const ref = found.value.secret_ref;
      if (Option.isNone(yield* firingSquire(row.squire_id))) return missing;

      const reject = (reason: "unauthorized" | "too_large") =>
        nowUtc.pipe(
          Effect.flatMap((now) => logRow(row, REJECTED, { reason }, now)),
          Effect.as({ outcome: reason }),
        );
      const bytes = yield* Effect.option(body);
      if (Option.isNone(bytes) || bytes.value.byteLength > MAX_BODY_BYTES) {
        return yield* reject("too_large");
      }
      const secret = yield* secrets.get(ref);
      const headers = lowerCaseHeaders(rawHeaders);
      if (
        Option.isNone(secret) ||
        !authorized(headers, bytes.value, new TextDecoder().decode(secret.value))
      ) {
        return yield* reject("unauthorized");
      }

      const deliveryId = deliveryIdOf(headers);
      const payloadExcerpt = excerptOf(new TextDecoder().decode(bytes.value));
      const now = yield* nowUtc;
      // The checks above ran before the body arrived. Re-read under the policy
      // lock, so a pause, revoke, rotation, or Squire pause the user committed
      // meanwhile wins over the admission.
      const admitted = yield* withPolicyLock(
        runLock(
          repository.transaction(
            Effect.gen(function* () {
              const current = yield* repository.getTrigger(row.id);
              if (
                Option.isNone(current) ||
                current.value.kind !== "webhook" ||
                current.value.status !== "active" ||
                Option.isNone(yield* firingSquire(current.value.squire_id))
              ) {
                return missing;
              }
              if (current.value.secret_ref !== ref) return { outcome: "rotated" } as const;
              const admission = yield* admit({
                row: current.value,
                origin: "webhook",
                stateKey: `${row.id}:${deliveryId}`,
                event: {
                  type: "webhook-received",
                  triggerId: row.id,
                  deliveryId,
                  instruction: current.value.instruction,
                  payloadExcerpt,
                },
                now,
              });
              if (admission.outcome === "queued") {
                yield* repository.updateTrigger({
                  id: row.id,
                  patch: { last_payload_excerpt: payloadExcerpt },
                });
              }
              return admission;
            }),
          ),
        ),
      );
      return admitted.outcome === "rotated" ? yield* reject("unauthorized") : admitted;
    }).pipe(orSquireError("receive the webhook"));

  /** User mutations only; the clock and webhooks are not the user acting. */
  const touched = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tap(() =>
        nowUtc.pipe(
          Effect.flatMap((now) => touchUserActivity(repository, DateTime.formatIso(now))),
        ),
      ),
    );

  const leadLog = (
    lead: SquireRepository.SquireRow,
    kind: string,
    data: Record<string, string>,
    at: string,
    refs: { readonly cardId?: SquireCardId; readonly eventId?: number } = {},
  ) =>
    repository.insertActionLog({
      squire_id: lead.id,
      kind,
      room_id: null,
      post_id: null,
      trigger_id: null,
      task_id: null,
      thread_id: null,
      card_id: refs.cardId ?? null,
      event_id: refs.eventId ?? null,
      run_id: null,
      invocation_key: null,
      execution_key: null,
      data_json: encodeLogData(data),
      created_at: at,
    });

  const closeInactivityCards = (
    leadId: SquireId,
    patch: { readonly status: "resolved" | "dismissed"; readonly resolution: string },
    at: string,
  ) =>
    Effect.gen(function* () {
      const open = yield* repository.listCards({
        squireId: leadId,
        kinds: ["fyi"],
        statuses: ["open"],
      });
      for (const card of open) {
        if (!card.id.startsWith(inactivityCardPrefix(leadId))) continue;
        yield* repository.updateCard({ id: card.id, fromStatuses: ["open"], patch, updatedAt: at });
      }
    });

  const notifyOn = (lead: SquireRepository.SquireRow) =>
    Option.getOrElse(decodePermissions(lead.permissions_json), () => DEFAULT_SQUIRE_PERMISSIONS)
      .notify === "on";

  /**
   * Inside the caller's transaction. A trigger the user paused stays paused
   * on a resume of all; naming it resumes it.
   */
  const resumeIn = (
    lead: SquireRepository.SquireRow,
    triggerIds: ReadonlyArray<SquireTriggerId> | undefined,
    now: DateTime.Utc,
  ) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(now);
      const named = triggerIds === undefined ? undefined : new Set<string>(triggerIds);
      for (const id of triggerIds ?? []) yield* requireTrigger(id);
      const wasPaused = lead.automation_paused_at !== null;
      const zone = yield* leadZone;
      const resumed: Array<string> = [];
      for (const squire of yield* repository.listSquires) {
        for (const row of yield* repository.listTriggers(squire.id)) {
          if (row.status === "revoked") continue;
          if (named !== undefined && !named.has(row.id)) {
            if (wasPaused && row.status === "active") {
              yield* repository.updateTrigger({
                id: row.id,
                patch: { status: "paused", next_slot_at: null },
              });
            }
            continue;
          }
          if (named === undefined) {
            if (!wasPaused || row.status !== "active") continue;
          } else if (row.status === "active" && !wasPaused) {
            continue;
          }
          // From now, so a slot missed while paused never fires.
          const schedule =
            row.schedule_json === null ? null : yield* decodeSchedule(row.schedule_json);
          yield* repository.updateTrigger({
            id: row.id,
            patch: {
              status: "active",
              next_slot_at:
                schedule === null
                  ? null
                  : Option.match(nextSlot(schedule, now, zone), {
                      onNone: () => null,
                      onSome: DateTime.formatIso,
                    }),
            },
          });
          resumed.push(row.id);
        }
      }
      if (wasPaused || lead.inactivity_prompted_at !== null) {
        yield* repository.updateSquire({
          id: lead.id,
          patch: { automation_paused_at: null, inactivity_prompted_at: null, user_active_at: at },
          updatedAt: at,
        });
      }
      if (wasPaused || resumed.length > 0) {
        yield* leadLog(
          lead,
          "automation.resumed",
          { scope: named === undefined ? "all" : "triggers", triggers: resumed.join(",") },
          at,
        );
      }
    });

  const checkInactivity: SquireTriggers["Service"]["checkInactivity"] = (now) =>
    Effect.gen(function* () {
      if (!enabled) return;
      const at = DateTime.formatIso(now);
      // Read here rather than from the settings stream: no fiber, and a
      // sweep-late stamp is nothing against a window of days.
      const squireSettings = (yield* serverSettings.getSettings).squire;
      const seen = encodeSquireSettings(squireSettings);
      const previous = yield* Ref.getAndSet(lastSquireSettings, Option.some(seen));
      if (Option.isSome(previous) && previous.value !== seen) {
        yield* touchUserActivity(repository, at);
      }
      const found = yield* repository.getLead;
      if (Option.isNone(found)) return;
      const lead = found.value;
      if (lead.automation_paused_at !== null) return;
      const nowMs = DateTime.toEpochMillis(now);
      const prompted = lead.inactivity_prompted_at;
      if (prompted === null) {
        const days = squireSettings.inactivityDays;
        const since = lead.user_active_at ?? lead.created_at;
        if (nowMs - DateTime.toEpochMillis(DateTime.makeUnsafe(since)) < days * DAY_MS) return;
        yield* repository.transaction(
          Effect.gen(function* () {
            // The revision guards against a concurrent answer or a second sweep.
            const claimed = yield* repository.updateSquire({
              id: lead.id,
              expectedRevision: lead.revision,
              patch: { inactivity_prompted_at: at },
              updatedAt: at,
            });
            if (Option.isNone(claimed)) return;
            const cardId = SquireCardId.make(`${inactivityCardPrefix(lead.id)}${at}`);
            const text = `No Squire activity here in ${days} day${days === 1 ? "" : "s"}. Keep leaves triggers and the find-work sweep running; Pause stops them until you resume. With no answer in 48 hours they pause.`;
            yield* repository.insertCard({
              id: cardId,
              squire_id: lead.id,
              owner_squire_id: lead.id,
              kind: "fyi",
              status: "open",
              target_thread_id: null,
              project_id: null,
              title: INACTIVITY_TITLE,
              why: text,
              payload_json: encodeCardPayload({
                type: "fyi",
                source: "inactivity",
                text,
                threadId: null,
              }),
              evidence_json: "{}",
              trigger_json: "{}",
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
              created_at: at,
              updated_at: at,
            });
            yield* leadLog(lead, "card.created", { kind: "fyi", source: "inactivity" }, at, {
              cardId,
            });
            yield* leadLog(
              lead,
              "automation.prompted",
              { inactivityDays: String(days), since },
              at,
              { cardId },
            );
            // The push intent row; SquireMobileAttention writes the mobile delivery row.
            if (notifyOn(lead)) {
              yield* leadLog(
                lead,
                "notification.pushed",
                { kind: "fyi", source: "inactivity" },
                at,
                { cardId },
              );
            }
          }),
        );
        return;
      }
      if (nowMs - DateTime.toEpochMillis(DateTime.makeUnsafe(prompted)) < INACTIVITY_ANSWER_MS) {
        return;
      }
      yield* repository.transaction(
        Effect.gen(function* () {
          const paused = yield* repository.updateSquire({
            id: lead.id,
            expectedRevision: lead.revision,
            patch: { automation_paused_at: at },
            updatedAt: at,
          });
          if (Option.isNone(paused)) return;
          // The card stays open: Keep on it resumes everything.
          const text =
            "Triggers and the find-work sweep paused after 48 hours without an answer. Keep resumes them.";
          const open = yield* repository.listCards({
            squireId: lead.id,
            kinds: ["fyi"],
            statuses: ["open"],
          });
          for (const card of open) {
            if (!card.id.startsWith(inactivityCardPrefix(lead.id))) continue;
            yield* repository.updateCard({
              id: card.id,
              fromStatuses: ["open"],
              patch: {
                why: text,
                payload_json: encodeCardPayload({
                  type: "fyi",
                  source: "inactivity",
                  text,
                  threadId: null,
                }),
              },
              updatedAt: at,
            });
          }
          // A system message the Lead's next turn reads, so its thread says so.
          const messageKey = `inactivity-paused:${at}`;
          const eventId = yield* repository.insertTriggerEvent({
            squire_id: lead.id,
            thread_id: null,
            kind: "message",
            state_key: messageKey,
            payload_json: encodeEvent({
              type: "message",
              messageKey,
              from: { kind: "system" },
              hop: 0,
              body: `Lecturn paused every Squire trigger and the find-work sweep: "${INACTIVITY_TITLE}" had no answer in 48 hours. Tell the user in a sentence or two; Keep on that item, or Resume in Settings > Squires, starts them again. Reactions to tracked threads continue.`,
            }),
            status: "pending",
            defer_reason: null,
            not_before: at,
            batch_id: null,
            created_at: at,
          });
          yield* leadLog(
            lead,
            "automation.paused",
            { reason: "no-answer", promptedAt: prompted },
            at,
            Option.match(eventId, { onNone: () => ({}), onSome: (id) => ({ eventId: id }) }),
          );
        }),
      );
    }).pipe(orSquireError("check Squire inactivity"));

  const answerInactivity: SquireTriggers["Service"]["answerInactivity"] = ({ keep }) =>
    requireEnabled.pipe(
      Effect.andThen(
        withPolicyLock(
          repository.transaction(
            Effect.gen(function* () {
              const found = yield* repository.getLead;
              if (Option.isNone(found)) return;
              const lead = found.value;
              const now = yield* nowUtc;
              const at = DateTime.formatIso(now);
              if (keep) {
                if (lead.automation_paused_at !== null) {
                  yield* resumeIn(lead, undefined, now);
                } else {
                  yield* repository.updateSquire({
                    id: lead.id,
                    patch: { inactivity_prompted_at: null, user_active_at: at },
                    updatedAt: at,
                  });
                }
                yield* closeInactivityCards(
                  lead.id,
                  { status: "resolved", resolution: "kept" },
                  at,
                );
                return;
              }
              if (lead.automation_paused_at === null) {
                yield* repository.updateSquire({
                  id: lead.id,
                  patch: {
                    automation_paused_at: at,
                    inactivity_prompted_at: null,
                    user_active_at: at,
                  },
                  updatedAt: at,
                });
                yield* leadLog(lead, "automation.paused", { reason: "user" }, at);
              }
              yield* closeInactivityCards(
                lead.id,
                { status: "dismissed", resolution: "paused" },
                at,
              );
            }),
          ),
        ),
      ),
      orSquireError("answer the inactivity check"),
    );

  const resumeAutomation: SquireTriggers["Service"]["resumeAutomation"] = (input) =>
    requireEnabled.pipe(
      Effect.andThen(
        withPolicyLock(
          repository.transaction(
            Effect.gen(function* () {
              const found = yield* repository.getLead;
              // Without a Lead nothing was paused for inactivity.
              if (Option.isNone(found)) return {};
              yield* resumeIn(found.value, input.triggerIds, yield* nowUtc);
              return {};
            }),
          ),
        ),
      ),
      touched,
      orSquireError("resume Squire automation"),
    );

  return SquireTriggers.of({
    list,
    create,
    update,
    rotate,
    revoke,
    test,
    fireDueSlots,
    earliestSlotAt,
    receive,
    checkInactivity,
    answerInactivity,
    resumeAutomation,
  });
});

export const layer = Layer.effect(SquireTriggers, make);
