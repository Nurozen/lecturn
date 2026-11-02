/**
 * The Lead's daily digest (P11, D31). Its own scheduler: the Lead's local
 * date comes from the pure `nextScheduledRunAt`, `digest_last_date` is a
 * compare-and-set, and a missed slot catches up once later the same local day.
 * The `digest-due` event carries a bounded input built from stored items,
 * summaries, and the action log, never transcripts.
 */
import {
  DEFAULT_SQUIRE_BUDGETS,
  SquireBudgets,
  SquireCardId,
  SquireCardPayload,
  SquireDigest as SquireDigestSettings,
  type SquireDigestInput,
  type SquireDigestLine,
  SquireError,
  SquireEvent,
  SQUIRE_DIGEST_MAX_LINES,
  SQUIRE_DIGEST_MAX_SQUIRES,
  SquirePermissions,
  SquireTurnSummary,
  type ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import { SquireEventPayloadJson } from "./squireEvents.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import * as SquirePresence from "./SquirePresence.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireSweep from "./SquireSweep.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const LINE_CHARS = 200;
const SUMMARY_KINDS: ReadonlySet<string> = new Set(["turn-finished", "thread-stopped"]);

const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(SquireDigestSettings));
const decodePermissions = Schema.decodeUnknownOption(Schema.fromJsonString(SquirePermissions));
const decodeBudgets = Schema.decodeUnknownOption(Schema.fromJsonString(SquireBudgets));
const decodePayload = Schema.decodeUnknownOption(SquireEventPayloadJson);
const decodeSummary = Schema.decodeUnknownOption(Schema.fromJsonString(SquireTurnSummary));
const decodeLogData = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));
const encodeCardPayload = Schema.encodeSync(Schema.fromJsonString(SquireCardPayload));

const line = (text: string, threadId: ThreadId | null, cardId: SquireCardId | null = null) =>
  ({
    text: text.length <= LINE_CHARS ? text : `${text.slice(0, LINE_CHARS - 1)}…`,
    threadId,
    cardId,
  }) satisfies SquireDigestLine;

export class SquireDigest extends Context.Service<
  SquireDigest,
  {
    /** Enqueues today's `digest-due` once, when its local time has passed; true when it did. */
    readonly due: (now: DateTime.Utc) => Effect.Effect<boolean, SquireError>;
    /** The next moment `due` has work, for SquireClock to arm on. */
    readonly nextDueAt: (
      now: DateTime.Utc,
    ) => Effect.Effect<Option.Option<DateTime.Utc>, SquireError>;
  }
>()("lecturn/squire/SquireDigest") {}

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const sweep = yield* SquireSweep.SquireSweep;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const delivery = yield* Effect.serviceOption(SquireDelivery.SquireDelivery);
  const presence = yield* Effect.serviceOption(SquirePresence.SquirePresence);
  const enabled = Option.isSome(config) && config.value.squireEnabled;

  /** The digest's time when it is on (`digest_json` set) and the Lead can take a turn. */
  const scheduleOf = (lead: SquireRepository.SquireRow) =>
    enabled &&
    lead.status === "active" &&
    lead.lifecycle === "ready" &&
    lead.home_thread_id !== null
      ? decodeSettings(lead.digest_json ?? "")
      : Option.none();

  /** Today's local date when its slot has passed and the date is newer than the last digest. */
  const dueDate = (lead: SquireRepository.SquireRow, now: DateTime.Utc) =>
    Option.flatMap(scheduleOf(lead), (settings) => {
      const zone = SquireSweep.leadZoneOf(lead);
      const today = SquireSweep.localDateOf(now, zone);
      // A zone change that moves the local date back never repeats a sent digest.
      if (lead.digest_last_date !== null && lead.digest_last_date >= today) return Option.none();
      return Option.flatMap(SquireSweep.dailySlotOn(settings.time, zone, now), (slot) =>
        DateTime.isLessThanOrEqualTo(slot, now) ? Option.some(today) : Option.none(),
      );
    });

  const squireSection = (row: SquireRepository.SquireRow, since: string) =>
    Effect.gen(function* () {
      // The latest summary-bearing delivery per thread, in the window.
      const latest = new Map<ThreadId, SquireRepository.SquireEventRow>();
      for (const event of yield* repository.listEventsByStatus({
        squireId: row.id,
        statuses: ["batched", "delivered"],
      })) {
        if (
          event.thread_id !== null &&
          SUMMARY_KINDS.has(event.kind) &&
          event.created_at >= since
        ) {
          latest.set(event.thread_id, event);
        }
      }
      const moved: Array<SquireDigestLine> = [];
      const blocked: Array<SquireDigestLine> = [];
      for (const [threadId, event] of latest) {
        const runId = Option.getOrNull(decodePayload(event.payload_json ?? ""))?.runId ?? null;
        if (runId === null) continue;
        const rows = yield* repository.listRunSummaries({ thread_id: threadId, run_id: runId });
        const stored = rows.find((entry) => entry.stage === "terminal") ?? rows.at(-1);
        const summary = Option.getOrNull(decodeSummary(stored?.summary_json ?? ""));
        if (summary === null) continue;
        const firstBlock = summary.blocked[0];
        if (firstBlock !== undefined || summary.outcome === "error") {
          blocked.push(
            line(
              `${summary.threadTitle}: ${firstBlock ? `${firstBlock.item} (${firstBlock.reason})` : "the turn failed"}`,
              threadId,
            ),
          );
        } else {
          moved.push(
            line(
              `${summary.threadTitle}: ${summary.completed[0] ?? (summary.goal || summary.outcome)}`,
              threadId,
            ),
          );
        }
      }
      const waiting = (yield* repository.listCards({ ownerSquireId: row.id, statuses: ["open"] }))
        .filter((card) => card.kind !== "fyi")
        .map((card) => line(`${card.kind}: ${card.title}`, card.target_thread_id, card.id));
      const onItsOwn: Array<SquireDigestLine> = [];
      for (const entry of yield* repository.listActionLogAfter({
        squireId: row.id,
        kinds: ["action.executed"],
        after: since,
      })) {
        const data = Option.getOrElse(decodeLogData(entry.data_json), () => ({}));
        // `execute` is a held Auto action running out its undo window; `accept` was the user.
        if (!("verb" in data) || data.verb !== "execute") continue;
        const card =
          entry.card_id === null ? Option.none() : yield* repository.getCard(entry.card_id);
        const title = Option.match(card, {
          onNone: () => String("action" in data ? data.action : "action"),
          onSome: (found) => found.title,
        });
        onItsOwn.push(line(title, entry.thread_id, entry.card_id));
      }
      const budgets = Option.getOrElse(
        decodeBudgets(row.budgets_json),
        () => DEFAULT_SQUIRE_BUDGETS,
      );
      const usage = yield* repository.listBudgetUsage({ squireId: row.id, since });
      const used = (kind: SquireRepository.SquireBudgetUsageRow["kind"]) =>
        usage.filter((entry) => entry.kind === kind).length;
      const cap = (lines: ReadonlyArray<SquireDigestLine>) => lines.slice(-SQUIRE_DIGEST_MAX_LINES);
      return {
        squireId: row.id,
        name: row.name,
        status: row.status,
        moved: cap(moved),
        blocked: cap(blocked),
        waiting: waiting.slice(0, SQUIRE_DIGEST_MAX_LINES),
        onItsOwn: cap(onItsOwn),
        budget: {
          steers: { used: used("steer"), limit: budgets.steersPerDay },
          threads: { used: used("thread"), limit: budgets.threadsPerDay },
        },
      };
    });

  const buildInput = (lead: SquireRepository.SquireRow, now: DateTime.Utc) =>
    Effect.gen(function* () {
      const since = DateTime.formatIso(DateTime.subtract(now, { milliseconds: DAY_MS }));
      const squires = (yield* repository.listSquires)
        .filter((row) => row.role === "squire" && row.lifecycle !== "deleting")
        .slice(0, SQUIRE_DIGEST_MAX_SQUIRES);
      return {
        since,
        squires: yield* Effect.forEach(squires, (row) => squireSection(row, since)),
        sweep: yield* sweep.acceptanceRate(lead.id, now),
      } satisfies SquireDigestInput;
    });

  /** D26, D27: a pushed digest is an FYI on the Lead with its intent row, inside the enqueue. */
  const pushDigest = (lead: SquireRepository.SquireRow, date: string, at: string) =>
    Effect.gen(function* () {
      const cardId = SquireCardId.make(`card:fyi:${lead.id}:digest:${date}`);
      const text = `Your daily digest for ${date} is ready.`;
      yield* repository.insertCard({
        id: cardId,
        squire_id: lead.id,
        owner_squire_id: lead.id,
        kind: "fyi",
        status: "open",
        target_thread_id: null,
        project_id: null,
        title: text,
        why: "",
        payload_json: encodeCardPayload({ type: "fyi", source: "digest", text, threadId: null }),
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
      const log = (kind: string, data: Record<string, unknown>) =>
        repository.insertActionLog({
          squire_id: lead.id,
          kind,
          room_id: null,
          post_id: null,
          trigger_id: null,
          task_id: null,
          thread_id: null,
          card_id: cardId,
          event_id: null,
          run_id: null,
          invocation_key: null,
          execution_key: null,
          data_json: JSON.stringify(data),
          created_at: at,
        });
      yield* log("card.created", { kind: "fyi", origin: "event", source: "digest" });
      yield* log("notification.pushed", { kind: "fyi", source: "digest" });
      // SquireMobileAttention writes the mobile delivery row; a held FYI never gets one.
      if (Option.isSome(presence)) {
        yield* presence.value.holdIntent({
          squireId: lead.id,
          cardId,
          kind: "fyi",
          threadId: null,
          runId: null,
          now: at,
        });
      }
    });

  const due: SquireDigest["Service"]["due"] = (now) =>
    Effect.gen(function* () {
      const found = yield* repository.getLead;
      if (Option.isNone(found)) return false;
      const lead = found.value;
      const date = dueDate(lead, now);
      if (Option.isNone(date)) return false;
      const settings = Option.getOrThrow(scheduleOf(lead));
      const digest = yield* buildInput(lead, now);
      const at = DateTime.formatIso(now);
      const queued = yield* repository.transaction(
        Effect.gen(function* () {
          if (
            !(yield* repository.claimDigestDate({
              id: lead.id,
              from: lead.digest_last_date,
              to: date.value,
            }))
          ) {
            return false;
          }
          const inserted = yield* repository.insertTriggerEvent({
            squire_id: lead.id,
            thread_id: null,
            kind: "digest-due",
            state_key: date.value,
            payload_json: encodeEvent({ type: "digest-due", date: date.value, digest }),
            status: "pending",
            defer_reason: null,
            not_before: at,
            batch_id: null,
            created_at: at,
          });
          if (Option.isNone(inserted)) return false;
          const notifyOn = Option.exists(
            decodePermissions(lead.permissions_json),
            (permissions) => permissions.notify === "on",
          );
          if (settings.push && notifyOn) yield* pushDigest(lead, date.value, at);
          return true;
        }),
      );
      if (queued && Option.isSome(delivery)) yield* delivery.value.wake(lead.id);
      return queued;
    }).pipe(orSquireError("enqueue the daily digest"));

  const nextDueAt: SquireDigest["Service"]["nextDueAt"] = (now) =>
    Effect.gen(function* () {
      const found = yield* repository.getLead;
      if (Option.isNone(found)) return Option.none();
      const lead = found.value;
      if (Option.isSome(dueDate(lead, now))) return Option.some(now);
      return Option.flatMap(scheduleOf(lead), (settings) =>
        SquireSweep.nextDailySlot(settings.time, SquireSweep.leadZoneOf(lead), now),
      );
    }).pipe(orSquireError("read the next digest time"));

  return SquireDigest.of({ due, nextDueAt });
});

export const layer = Layer.effect(SquireDigest, make);
