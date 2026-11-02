import {
  type BackgroundPolicySnapshot,
  type ClientActivityLease,
  type SquireCardId,
  SquireError,
  type SquireId,
  type SquireItemsMarkOpenedInput,
  type SquireItemsMarkOpenedResult,
  type SquireNotificationAlertedInput,
  type SquireNotificationAlertedResult,
  type SquirePhoneAlertsWhileDesktop,
  type ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ServerSettings from "../serverSettings.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import { SquireCardRow, SquireRepository } from "./SquireRepository.ts";
import { touchUserActivity } from "./squireUserActivity.ts";

/** D52: a lease reports interaction over its last 45 s; a desktop stays active this long after it. */
const SQUIRE_DESKTOP_INTERACTION_WINDOW_MS = 2 * 60_000;
/** P7.10: measured from the intent, server-side. */
export const SQUIRE_ESCALATION_DELAY_MS = 3 * 60_000;

/**
 * Phase 12's attention set leaves these out (D52). A decision card keeps
 * `escalate_at` until it escalates; opening it first keeps the card held back
 * for good. An FYI's `escalate_at` only marks it held back: FYIs never come due.
 */
export const isHeldBackByPresence = (card: Pick<SquireCardRow, "escalate_at">) =>
  card.escalate_at !== null;

export interface SquireIntent {
  readonly squireId: SquireId;
  readonly cardId: SquireCardId;
  readonly kind: SquireCardRow["kind"];
  readonly threadId: ThreadId | null;
  readonly runId: string | null;
  readonly now: string;
}

/**
 * P7.10, D52: whether a desktop is in active use, from the existing client
 * activity leases, and the escalation of intents held back while it is.
 */
export class SquirePresence extends Context.Service<
  SquirePresence,
  {
    readonly desktopActive: Effect.Effect<boolean>;
    /**
     * Inside the caller's transaction, for a card intent that would alert the
     * phone: true when it was held back (its `deferred_desktop_active` row is
     * written), false when the phone should be alerted now.
     */
    readonly holdIntent: (intent: SquireIntent) => Effect.Effect<boolean, PersistenceSqlError>;
    /** Escalates due holds, and closes the ones opened or acted on first. */
    readonly escalateDue: Effect.Effect<void, PersistenceSqlError>;
    /** For `SquireClock`, which re-arms from `escalate_at` at startup (A9). */
    readonly nextEscalationAt: Effect.Effect<Option.Option<DateTime.Utc>, PersistenceSqlError>;
    /** No card ids means a Squire view opened, which still counts as activity (P3.6). */
    readonly markOpened: (
      input: typeof SquireItemsMarkOpenedInput.Type,
    ) => Effect.Effect<typeof SquireItemsMarkOpenedResult.Type, SquireError>;
    /**
     * D27: a desktop alerted for a card's notification intent. Writes one
     * `notification.delivery` row (`alerted`, the surface) per card and
     * surface; refuses a card that is not this Squire's or never pushed.
     */
    readonly markAlerted: (
      input: typeof SquireNotificationAlertedInput.Type,
    ) => Effect.Effect<typeof SquireNotificationAlertedResult.Type, SquireError>;
  }
>()("lecturn/squire/SquirePresence") {}

const decodeDeliveryData = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      outcome: Schema.optionalKey(Schema.String),
      surface: Schema.optionalKey(Schema.String),
    }),
  ),
);

const DESKTOP_KINDS: ReadonlySet<ClientActivityLease["clientKind"]> = new Set([
  "web",
  "desktop-renderer",
]);
const ALL_CARD_STATUSES = SquireCardRow.fields.status.literals;
const NOT_OPEN_STATUSES = ALL_CARD_STATUSES.filter((status) => status !== "open");

const leaseKey = (lease: ClientActivityLease) =>
  JSON.stringify([lease.sessionId, lease.rpcClientId, lease.clientId]);

const make = Effect.gen(function* () {
  const policy = yield* BackgroundPolicy.BackgroundPolicy;
  const settings = yield* ServerSettings.ServerSettingsService;
  const repository = yield* SquireRepository;
  // In memory on purpose: after a restart no desktop is active until a report
  // arrives, so the phone errs toward alerting (R105).
  const lastInteraction = yield* Ref.make(new Map<string, number>());
  const lock = yield* Semaphore.make(1);

  const record = (snapshot: BackgroundPolicySnapshot) =>
    Ref.update(lastInteraction, (previous) => {
      const next = new Map<string, number>();
      for (const lease of snapshot.leases) {
        const key = leaseKey(lease);
        const seen = previous.get(key);
        const reported = lease.recentlyInteracted
          ? DateTime.toEpochMillis(lease.updatedAt)
          : undefined;
        const latest = Math.max(seen ?? -Infinity, reported ?? -Infinity);
        if (Number.isFinite(latest)) next.set(key, latest);
      }
      return next;
    });

  const { latest, changes } = yield* policy.subscribe;
  yield* record(latest);
  yield* Stream.runForEach(changes, record).pipe(Effect.forkScoped);

  /** When the last active desktop stops counting, absent any new report; None when none is active. */
  const activeUntil = Effect.gen(function* () {
    const snapshot = yield* policy.snapshot;
    yield* record(snapshot);
    const interactions = yield* Ref.get(lastInteraction);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    let until: number | undefined;
    for (const lease of snapshot.leases) {
      if (!DESKTOP_KINDS.has(lease.clientKind) || !lease.visible || !lease.focused) continue;
      const interacted = interactions.get(leaseKey(lease));
      if (interacted === undefined) continue;
      const end = Math.min(
        DateTime.toEpochMillis(lease.expiresAt),
        interacted + SQUIRE_DESKTOP_INTERACTION_WINDOW_MS,
      );
      if (end > now && (until === undefined || end > until)) until = end;
    }
    return Option.fromUndefinedOr(until).pipe(Option.map(DateTime.makeUnsafe));
  });

  const desktopActive = Effect.map(activeUntil, Option.isSome);

  const phoneAlerts = settings.getSettings.pipe(
    Effect.map((current): SquirePhoneAlertsWhileDesktop => current.squire.phoneAlertsWhileDesktop),
    Effect.orElseSucceed((): SquirePhoneAlertsWhileDesktop => "after-3-min"),
  );

  const deliveryRow = (
    card: Pick<SquireCardRow, "id" | "squire_id" | "target_thread_id">,
    data: Record<string, unknown>,
    now: string,
    runId: string | null = null,
  ) =>
    repository.insertActionLog({
      squire_id: card.squire_id,
      kind: "notification.delivery",
      room_id: null,
      post_id: null,
      trigger_id: null,
      task_id: null,
      thread_id: card.target_thread_id,
      card_id: card.id,
      event_id: null,
      run_id: runId,
      invocation_key: null,
      execution_key: null,
      data_json: JSON.stringify(data),
      created_at: now,
    });

  const holdIntent: SquirePresence["Service"]["holdIntent"] = (intent) =>
    Effect.gen(function* () {
      if ((yield* phoneAlerts) === "immediately" || !(yield* desktopActive)) return false;
      const escalates = intent.kind !== "fyi";
      const escalateAt = DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(intent.now), { milliseconds: SQUIRE_ESCALATION_DELAY_MS }),
      );
      const held = yield* repository.updateCard({
        id: intent.cardId,
        fromStatuses: ["open"],
        patch: { escalate_at: escalateAt },
        updatedAt: intent.now,
      });
      if (Option.isNone(held)) return false;
      yield* deliveryRow(
        { id: intent.cardId, squire_id: intent.squireId, target_thread_id: intent.threadId },
        {
          outcome: "deferred_desktop_active",
          kind: intent.kind,
          ...(escalates ? { escalateAt } : { escalates: false }),
        },
        intent.now,
        intent.runId,
      );
      return true;
    });

  const isDue = (card: SquireCardRow, now: number) => Date.parse(card.escalate_at ?? "") <= now;

  // Only `opened_at` and the card's status decide: a desktop going inactive
  // meanwhile never shortens the timer. "Never" additionally waits for no
  // active desktop.
  const escalateDue: SquirePresence["Service"]["escalateDue"] = lock.withPermits(1)(
    Effect.gen(function* () {
      const pending = yield* repository.listPendingEscalations;
      const nowUtc = yield* DateTime.now;
      const now = DateTime.toEpochMillis(nowUtc);
      const due = pending.filter((card) => isDue(card, now));
      if (due.length === 0) return;
      const nowIso = DateTime.formatIso(nowUtc);
      const holdWhileActive = (yield* phoneAlerts) === "never" && (yield* desktopActive);
      yield* repository.transaction(
        Effect.forEach(
          due,
          (card) =>
            Effect.gen(function* () {
              if (card.status !== "open") {
                const closed = yield* repository.updateCard({
                  id: card.id,
                  fromStatuses: NOT_OPEN_STATUSES,
                  patch: { escalate_at: null },
                  updatedAt: nowIso,
                });
                if (Option.isSome(closed)) {
                  yield* deliveryRow(
                    card,
                    { outcome: "opened_before_escalation", via: "acted" },
                    nowIso,
                  );
                }
                return;
              }
              if (holdWhileActive) return;
              const escalated = yield* repository.updateCard({
                id: card.id,
                fromStatuses: ["open"],
                patch: { escalate_at: null },
                updatedAt: nowIso,
              });
              if (Option.isSome(escalated)) {
                yield* deliveryRow(card, { outcome: "escalated", kind: card.kind }, nowIso);
              }
            }),
          { discard: true },
        ),
      );
    }),
  );

  const nextEscalationAt: SquirePresence["Service"]["nextEscalationAt"] = Effect.gen(function* () {
    const pending = yield* repository.listPendingEscalations;
    if (pending.length === 0) return Option.none();
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const upcoming = pending.find((card) => !isDue(card, now));
    const waiting = pending.some((card) => isDue(card, now));
    // Due ones still pending are "Never" holds waiting for the desktop to go quiet.
    const quietAt = waiting ? yield* activeUntil : Option.none();
    const candidates = [
      ...(upcoming === undefined ? [] : [DateTime.makeUnsafe(upcoming.escalate_at ?? now)]),
      ...(waiting ? [Option.getOrElse(quietAt, () => DateTime.makeUnsafe(now))] : []),
    ];
    return Option.some(candidates.reduce((earliest, at) => DateTime.min(earliest, at)));
  });

  const markOpened: SquirePresence["Service"]["markOpened"] = (input) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* touchUserActivity(repository, now);
          if (input.cardIds.length === 0) return {};
          // Idempotent on requestId without a ledger: a card's `opened_at` is
          // written once, and only that first write logs.
          yield* repository.transaction(
            Effect.forEach(
              new Set(input.cardIds),
              (cardId) =>
                Effect.gen(function* () {
                  const found = yield* repository.getCard(cardId);
                  if (Option.isNone(found) || found.value.opened_at !== null) return;
                  const card = found.value;
                  yield* repository.updateCard({
                    id: card.id,
                    fromStatuses: [card.status],
                    patch: { opened_at: now },
                    updatedAt: now,
                  });
                  // An acted-on hold not yet due is still pending: opening it closes it here.
                  if (card.kind !== "fyi" && isHeldBackByPresence(card)) {
                    yield* deliveryRow(
                      card,
                      { outcome: "opened_before_escalation", via: "opened" },
                      now,
                    );
                  }
                }),
              { discard: true },
            ),
          );
          return {};
        }),
      )
      .pipe(orSquireError("mark the items opened"));

  const markAlerted: SquirePresence["Service"]["markAlerted"] = (input) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* repository.transaction(
            Effect.gen(function* () {
              const found = yield* repository.getCard(input.cardId);
              const card = Option.getOrNull(found);
              const rows =
                card === null
                  ? []
                  : yield* repository.listCardLog({
                      cardId: card.id,
                      kinds: ["notification.pushed", "notification.delivery"],
                    });
              const pushed = rows.some(
                (row) => row.kind === "notification.pushed" && row.squire_id === input.squireId,
              );
              if (card === null || card.squire_id !== input.squireId || !pushed) {
                return yield* new SquireError({
                  code: "not_found",
                  message: "This notification is not one of this Squire's.",
                });
              }
              const alerted = rows.some((row) => {
                if (row.kind !== "notification.delivery") return false;
                const data = decodeDeliveryData(row.data_json);
                return (
                  Option.isSome(data) &&
                  data.value.outcome === "alerted" &&
                  data.value.surface === input.surface
                );
              });
              if (!alerted) {
                yield* deliveryRow(card, { outcome: "alerted", surface: input.surface }, now);
              }
              return {};
            }),
          );
        }),
      )
      .pipe(orSquireError("record the alert"));

  return SquirePresence.of({
    desktopActive,
    holdIntent,
    escalateDue,
    nextEscalationAt,
    markOpened,
    markAlerted,
  });
});

export const layer = Layer.effect(SquirePresence, make);
